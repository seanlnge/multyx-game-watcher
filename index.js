const express = require('express');
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { AutoScalingClient, DescribeAutoScalingGroupsCommand } = require('@aws-sdk/client-auto-scaling');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3008;

// Configure AWS region (update as needed)
const AWSConfig = {
    region: 'us-east-2',
    credentials: {
        accessKeyId: process.env.ACCESS_KEY,
        secretAccessKey: process.env.SECRET_KEY
    }
};

const ec2 = new EC2Client(AWSConfig);
const autoscaling = new AutoScalingClient(AWSConfig);

// Each entry will be { instanceId, availableCpu, availableMemory, totalCpu, totalMemory }
const InstanceCache = [];

async function updateInstanceCache() {
    try {
        // Retrieve instances from your Auto Scaling Group
        const asgData = await autoscaling.send(new DescribeAutoScalingGroupsCommand({
            AutoScalingGroupNames: [process.env.ASG]
        }));

        const newInstanceIds = [];
        if(asgData.AutoScalingGroups && asgData.AutoScalingGroups.length > 0) {
            asgData.AutoScalingGroups.forEach(asg => {
                asg.Instances.forEach(inst => {
                    if (inst.LifecycleState === 'InService') {
                        if(!InstanceCache.find(x => x.id == inst.InstanceId)) {
                            newInstanceIds.push(inst.InstanceId);
                        }
                    }
                });
            });
        }
        
        InstanceCache.push(...newInstanceIds.map(instanceId => ({
            id: instanceId,
            freeMemory: 2048, // assuming c7a.medium instanceType
            freeCPU: 1,       // assuming c7a.medium instanceType
        })));

        console.log("Updated instance cache:", InstanceCache);
    } catch (err) {
        console.error("Error updating instance cache:", err);
    }
}

// Update the cache immediately, then every minute (60000ms)
updateInstanceCache();
setInterval(updateInstanceCache, 60000);


function AllocateInstance(cpu, memory) {
    for(const instance of InstanceCache) {
        if(instance.freeCPU > cpu && instance.freeMemory > memory) {
            instance.freeCPU -= cpu;
            instance.freeMemory -= memory;
            return instance.id;
        }
    }
}

function DeallocateInstance(instanceId, cpu, memory) {
    const instance = InstanceCache.find(x => x.id == instanceId);
    instance.freeCpu += cpu;
    instance.freeMemory += memory;
    return instance;
}

app.get('/allocate_instance', (req, res) => {
    const requiredCpu = parseFloat(req.query.requiredCpu);
    const requiredMemory = parseFloat(req.query.requiredMemory);

    if(isNaN(requiredCpu) || isNaN(requiredMemory)) {
        return res.status(400).json({ error: 'Invalid or missing resource requirements.' });
    }

    const instanceId = AllocateInstance(requiredCpu, requiredMemory);

    if(instanceId) {
        res.json(instanceId);
    } else {
        res.status(500).json({ error: 'Could not find available instance' });
    }
});

app.get('/deallocate_instance', (req, res) => {
    const cpu = parseFloat(req.query.cpu);
    const memory = parseFloat(req.query.memory);
    const instanceId = req.query.instanceId;

    if(isNaN(requiredCpu) || isNaN(requiredMemory)) {
        return res.status(400).json({ error: 'Invalid or missing resource requirements.' });
    }

    const resp = DeallocateInstance(instanceId, cpu, memory);

    if(resp) {
        res.status(200);
    } else {
        res.status(500).json({ error: 'Could not find available instance' });
    }
});

app.listen(port, () => {
    console.log(`Game watcher service is running at http://localhost:${port}`);
});