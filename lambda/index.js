const { createClient } = require("redis");
const { SFNClient, StartExecutionCommand } = require("@aws-sdk/client-sfn");
const postgres = require("postgres");

const stepFunctionClient = new SFNClient({
    region: "us-east-2",
    credentials: {
        accessKeyId: env.ACCESS_KEY,
        secretAccessKey: env.SECRET_KEY
    }
});

const client = createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT)
    }
}).on('error', err => console.log('Redis Client Error', err));

async function ConnectRedis() {
    if(client.isReady) return;
    await client.connect();
}

const sql = postgres(env.DATABASE_URL);

const CalculateTokensPerHour = (vCPU, gbRAM) => {
    const vcpuTPH = parseFloat(vCPU) * 3.279724529;
    const gbramTPH = parseFloat(gbRAM) * 0.3601377355;
    return vcpuTPH + gbramTPH;
}

function Terminate(spaceId, arn) {
    const sfnInput = { spaceId, arn, operation: "deleting" };

    return stepFunctionClient.send(new StartExecutionCommand({
        stateMachineArn: env.UNDEPLOY_SFN_ARN,
        input: JSON.stringify(sfnInput)
    }));
}

exports.handler = async () => {
    await ConnectRedis();

    const msSinceLastMonitor = Date.now() - parseInt(await client.get("lastMonitorTime"));
    await client.set("lastMonitorTime", Date.now());
    const hoursUsed = msSinceLastMonitor / (60 * 60 * 1000);

    const keys = await client.keys("space:*");

    const withdrawTokenMap = new Map();

    for(const key of keys) {
        const spaceId = parseInt(key.split("space:")[1]);
        if(isNaN(spaceId)) continue;

        const space = await client.hGetAll(key);
        
        const terminationMillis = 60 * 1000 * parseInt(space.terminationMinutes);
        const millisInactive = Date.now() - parseInt(space.inactiveSince);
        if(parseInt(space.players) == 0 && terminationMillis > 0 && millisInactive > terminationMillis) {
            console.log(millisInactive);
            Terminate(spaceId, space.arn);
        }
        
        const tokensUsed = parseFloat(await client.hGet(key, "tokensUsed"));
        const withdrawTokens = hoursUsed * CalculateTokensPerHour(space.vcpu, space.gbram);
        if(isNaN(withdrawTokens)) continue;

        await client.hSet(key, "tokensUsed", tokensUsed + withdrawTokens);
        withdrawTokenMap.set(spaceId, { tokenAmount: withdrawTokens, arn: space.arn });
    }

    // Withdraw deploy tokens from all users
    for(let [spaceId, { tokenAmount, arn }] of withdrawTokenMap.entries()) {
        const [user] = await sql`
            SELECT deploy_tokens
            FROM multyxsite_creator
            WHERE id = (
                SELECT created_by
                FROM multyxsite_deployment
                WHERE space_id = ${spaceId}
                LIMIT 1
            )
        `;
        if(user.deploy_tokens < tokenAmount) {
            Terminate(spaceId, arn);
            tokenAmount = user.deploy_tokens;
        }

        await sql`
            UPDATE multyxsite_creator
            SET deploy_tokens = deploy_tokens - (${tokenAmount}::real)
            WHERE id = (
                SELECT created_by
                FROM multyxsite_deployment
                WHERE space_id = ${spaceId}
                LIMIT 1
            )
        `;
    }
}

exports.handler();