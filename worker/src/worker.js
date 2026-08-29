const { Worker } = require("bullmq");
require("dotenv").config();

const connection = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
};

const worker = new Worker(
  "csv-processing",
  async (job) => {
    console.log("Job received!");
    console.log("Job ID:", job.id);
    console.log("Job name:", job.name);
    console.log("Job data:", job.data);

    // Later we will process CSV here

    return {
      success: true,
    };
  },
  {
    connection,
  }
);

worker.on("completed", (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.log(`Job ${job.id} failed`);
  console.error(error);
});

console.log("Worker is running...");