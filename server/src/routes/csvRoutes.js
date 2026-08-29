const express = require('express');
const csvQueue = require("../queues/csvQueue");

const router = express.Router();

router.post("/add-job", async(req, res) => {
    try{
        const { name } = req.body;

        const job = await csvQueue.add("process-csv", {
            name,
        });

        res.status(201).json({
            message: "Job added Successfully",
            jobId: job.id,
        })
    }catch(error) {
        console.error(error);

        res.status(500).json({
            message: "Failed to add job"
        })
    }
})