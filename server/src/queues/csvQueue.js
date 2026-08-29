const { Queue } = require("bullmq");

const connection = {
    host: process.env.REDIS_HOST,
    port: process.env.RESID_PORT
}

const csvQueue = new Queue("csv-processing", {
    connection,
});

module.exports = csvQueue;