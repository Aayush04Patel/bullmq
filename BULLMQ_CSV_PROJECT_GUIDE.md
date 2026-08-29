# BullMQ CSV Processor Project Guide

This project teaches how to upload a CSV file, push CSV processing work into a BullMQ queue, process it in a separate worker, store rows in PostgreSQL, track progress, handle failures, retry jobs, and inspect jobs with Bull Board.

## Project Architecture

```txt
client/              Next.js frontend for CSV upload
server/              Express API, BullMQ queue producer, Bull Board
worker/              BullMQ worker, CSV parser, PostgreSQL inserts
docker-compose.yml   Redis and PostgreSQL services
```

Flow:

```txt
User uploads CSV
  -> Express API receives file
  -> API adds a BullMQ job
  -> Redis stores the job
  -> Worker picks the job
  -> Worker reads CSV rows
  -> Worker inserts rows into PostgreSQL
  -> BullMQ tracks progress, retries, completion, failure
  -> Bull Board shows job status
```

## Required Software

Install these first:

- Node.js 20 or newer
- npm
- Docker Desktop or Docker Engine
- Postman, Thunder Client, or curl for API testing

Check versions:

```bash
node -v
npm -v
docker -v
```

## Required Dependencies

Server dependencies:

```bash
cd server
npm install express dotenv pg bullmq ioredis multer cors @bull-board/api @bull-board/express
npm install -D nodemon
```

Worker dependencies:

```bash
cd worker
npm install dotenv pg bullmq ioredis csv-parser
npm install -D nodemon
```

Client dependencies:

```bash
cd client
npm install
```

What each dependency does:

```txt
express              API server
dotenv               Loads .env files
pg                   PostgreSQL client
bullmq               Queue, jobs, workers, retries, progress
ioredis              Redis connection used by BullMQ
multer               Handles CSV file uploads
cors                 Allows frontend to call backend
csv-parser           Streams and parses CSV rows
@bull-board/api      Bull Board core package
@bull-board/express  Bull Board Express adapter
nodemon              Restarts dev server on file changes
```

## Environment Files

Create `server/.env`:

```env
PORT=8000

PG_HOST=localhost
PG_PORT=5433
PG_USER=bullmq
PG_PASSWORD=bullmq
PG_DATABASE=bullmq_test

REDIS_HOST=localhost
REDIS_PORT=6380
```

Create `worker/.env`:

```env
PG_HOST=localhost
PG_PORT=5433
PG_USER=bullmq
PG_PASSWORD=bullmq
PG_DATABASE=bullmq_test

REDIS_HOST=localhost
REDIS_PORT=6380
```

Create `client/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Docker Services

Use Redis and PostgreSQL with Docker:

```yaml
services:
  redis:
    image: redis:7
    container_name: bullmq-redis
    ports:
      - "6380:6379"

  postgres:
    image: postgres:16
    container_name: bullmq-postgres
    environment:
      POSTGRES_USER: bullmq
      POSTGRES_PASSWORD: bullmq
      POSTGRES_DB: bullmq_test
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

Start services:

```bash
docker compose up -d
```

Stop services:

```bash
docker compose down
```

## Database Setup

Open PostgreSQL inside Docker:

```bash
docker exec -it bullmq-postgres psql -U bullmq -d bullmq_test
```

Create the table:

```sql
CREATE TABLE IF NOT EXISTS csv_records (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  age INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Check rows:

```sql
SELECT * FROM csv_records;
```

Exit psql:

```sql
\q
```

## Stage 1: BullMQ + Redis Connection

Create a shared Redis connection config.

`server/queue.js`:

```js
const { Queue } = require('bullmq');
require('dotenv').config();

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6380),
};

const csvQueue = new Queue('csv-processing', { connection });

module.exports = { csvQueue, connection };
```

`worker/queue.js`:

```js
require('dotenv').config();

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6380),
};

module.exports = { connection };
```

## Stage 2: Create a Queue

The queue is created by this line:

```js
const csvQueue = new Queue('csv-processing', { connection });
```

The queue name must match between the API and worker:

```txt
csv-processing
```

## Stage 3: Add the First Job

Add a test route in `server/index.js`:

```js
app.post('/jobs/test', async (req, res) => {
  const job = await csvQueue.add('test-job', {
    message: 'Hello from BullMQ',
  });

  res.status(201).json({
    message: 'Job added',
    jobId: job.id,
  });
});
```

Import the queue at the top:

```js
const { csvQueue } = require('./queue');
```

Test:

```bash
curl -X POST http://localhost:8000/jobs/test
```

## Stage 4: Create a Worker

Create `worker/worker.js`:

```js
const { Worker } = require('bullmq');
const { connection } = require('./queue');

const worker = new Worker(
  'csv-processing',
  async (job) => {
    console.log('Processing job:', job.id, job.name, job.data);
    return { ok: true };
  },
  { connection }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed:`, error.message);
});
```

Update `worker/package.json`:

```json
{
  "scripts": {
    "dev": "nodemon worker.js",
    "start": "node worker.js"
  }
}
```

Run worker:

```bash
cd worker
npm run dev
```

## Stage 5: Understand Job Lifecycle

BullMQ jobs normally move through these states:

```txt
waiting -> active -> completed
waiting -> active -> failed
waiting -> delayed -> waiting -> active
```

Common states:

```txt
waiting     Job is queued
active      Worker is processing it
completed   Worker finished successfully
failed      Worker threw an error
delayed     Job is scheduled for later or retry delay
paused      Queue is paused
```

## Stage 6: Add CSV Upload

In `server/index.js`, add multer:

```js
const path = require('path');
const multer = require('multer');

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.csv')) {
      return cb(new Error('Only CSV files are allowed'));
    }

    cb(null, true);
  },
});
```

Add route:

```js
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'CSV file is required' });
  }

  const job = await csvQueue.add(
    'process-csv',
    {
      filePath: req.file.path,
      originalName: req.file.originalname,
    },
    {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: false,
      removeOnFail: false,
    }
  );

  res.status(201).json({
    message: 'CSV upload queued',
    jobId: job.id,
  });
});
```

Test with curl:

```bash
curl -X POST http://localhost:8000/upload \
  -F "file=@sample.csv"
```

## Stage 7: Pass CSV Information Through the Queue

The API should not process the CSV directly. It only sends file metadata to Redis:

```js
{
  filePath: req.file.path,
  originalName: req.file.originalname
}
```

The worker receives it:

```js
const { filePath, originalName } = job.data;
```

## Stage 8: Worker Processes CSV

Create `worker/db.js`:

```js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

module.exports = pool;
```

Update `worker/worker.js`:

```js
const fs = require('fs');
const csv = require('csv-parser');
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const pool = require('./db');

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

const worker = new Worker(
  'csv-processing',
  async (job) => {
    const { filePath } = job.data;
    const rows = await readCsv(filePath);

    console.log(`Read ${rows.length} rows from CSV`);

    return { totalRows: rows.length };
  },
  { connection }
);
```

## Stage 9: Insert Results Into PostgreSQL

Inside the worker processor:

```js
for (const row of rows) {
  await pool.query(
    `
      INSERT INTO csv_records (name, email, age)
      VALUES ($1, $2, $3)
    `,
    [row.name, row.email, row.age ? Number(row.age) : null]
  );
}
```

Your CSV should look like this:

```csv
name,email,age
Aayush,aayush@example.com,22
Riya,riya@example.com,24
```

## Stage 10: Add Job Progress

Update progress after each row:

```js
for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];

  await pool.query(
    `
      INSERT INTO csv_records (name, email, age)
      VALUES ($1, $2, $3)
    `,
    [row.name, row.email, row.age ? Number(row.age) : null]
  );

  const progress = Math.round(((index + 1) / rows.length) * 100);
  await job.updateProgress(progress);
}
```

Add API route to check progress:

```js
app.get('/jobs/:id', async (req, res) => {
  const job = await csvQueue.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ message: 'Job not found' });
  }

  const state = await job.getState();

  res.json({
    id: job.id,
    name: job.name,
    state,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    returnvalue: job.returnvalue,
  });
});
```

## Stage 11: Handle Failed Jobs

Validate CSV rows in the worker:

```js
function validateRow(row, rowNumber) {
  if (!row.name || !row.email) {
    throw new Error(`Invalid row ${rowNumber}: name and email are required`);
  }
}
```

Use it before inserting:

```js
validateRow(row, index + 1);
```

Listen for failures:

```js
worker.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed:`, error.message);
});
```

## Stage 12: Add Retries

Retries are configured when adding the job:

```js
const job = await csvQueue.add('process-csv', data, {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
});
```

Meaning:

```txt
attempts: 3       BullMQ tries the job up to 3 times
delay: 2000       First retry waits about 2 seconds
exponential       Later retries wait longer
```

## Stage 13: Understand Concurrency

Concurrency means one worker process can handle multiple jobs at the same time.

```js
const worker = new Worker(
  'csv-processing',
  async (job) => {
    // process job
  },
  {
    connection,
    concurrency: 5,
  }
);
```

Use low concurrency when:

```txt
CSV files are large
Database inserts are heavy
You are running locally
```

Use higher concurrency when:

```txt
Jobs are small
Database can handle more writes
You have multiple CPU cores or multiple worker containers
```

## Stage 14: View Jobs Using Bull Board

Install Bull Board in `server`:

```bash
cd server
npm install @bull-board/api @bull-board/express
```

Add this to `server/index.js`:

```js
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
```

After creating `app` and importing `csvQueue`:

```js
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(csvQueue)],
  serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());
```

Open:

```txt
http://localhost:8000/admin/queues
```

## Final Server Example

`server/index.js` should eventually contain:

```js
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const pool = require('./db');
const { csvQueue } = require('./queue');
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');

const app = express();
const serverAdapter = new ExpressAdapter();

serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(csvQueue)],
  serverAdapter,
});

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith('.csv')) {
      return cb(new Error('Only CSV files are allowed'));
    }

    cb(null, true);
  },
});

app.use(cors());
app.use(express.json());
app.use('/admin/queues', serverAdapter.getRouter());

app.get('/', (req, res) => {
  res.json({ message: 'Server is running' });
});

app.post('/records', async (req, res) => {
  try {
    const { name, email, age } = req.body;

    const results = await pool.query(
      `
        INSERT INTO csv_records (name, email, age)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      [name, email, age]
    );

    res.status(201).json({
      message: 'Record inserted successfully',
      record: results.rows[0],
    });
  } catch (error) {
    console.error('Database error', error);
    res.status(500).json({ message: 'Failed to insert record' });
  }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'CSV file is required' });
    }

    const job = await csvQueue.add(
      'process-csv',
      {
        filePath: req.file.path,
        originalName: req.file.originalname,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: false,
        removeOnFail: false,
      }
    );

    res.status(201).json({
      message: 'CSV upload queued',
      jobId: job.id,
    });
  } catch (error) {
    console.error('Upload error', error);
    res.status(500).json({ message: 'Failed to queue CSV upload' });
  }
});

app.get('/jobs/:id', async (req, res) => {
  const job = await csvQueue.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ message: 'Job not found' });
  }

  const state = await job.getState();

  res.json({
    id: job.id,
    name: job.name,
    state,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    returnvalue: job.returnvalue,
  });
});

const port = process.env.PORT || 8000;

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
```

## Final Worker Example

`worker/worker.js` should eventually contain:

```js
const fs = require('fs');
const csv = require('csv-parser');
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const pool = require('./db');

function readCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function validateRow(row, rowNumber) {
  if (!row.name || !row.email) {
    throw new Error(`Invalid row ${rowNumber}: name and email are required`);
  }
}

const worker = new Worker(
  'csv-processing',
  async (job) => {
    const { filePath, originalName } = job.data;
    const rows = await readCsv(filePath);

    if (rows.length === 0) {
      throw new Error('CSV file is empty');
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      validateRow(row, index + 1);

      await pool.query(
        `
          INSERT INTO csv_records (name, email, age)
          VALUES ($1, $2, $3)
        `,
        [row.name, row.email, row.age ? Number(row.age) : null]
      );

      const progress = Math.round(((index + 1) / rows.length) * 100);
      await job.updateProgress(progress);
    }

    return {
      originalName,
      insertedRows: rows.length,
    };
  },
  {
    connection,
    concurrency: 3,
  }
);

worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed`, result);
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job.id} failed:`, error.message);
});
```

## Frontend Upload Example

In `client/app/page.js`, create a file input and submit the CSV:

```js
'use client';

import { useState } from 'react';

export default function Home() {
  const [file, setFile] = useState(null);
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState('');

  async function uploadCsv(event) {
    event.preventDefault();

    if (!file) {
      setStatus('Please select a CSV file');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/upload`, {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();

    setJobId(data.jobId || '');
    setStatus(data.message);
  }

  async function checkJob() {
    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/jobs/${jobId}`);
    const data = await response.json();
    setStatus(JSON.stringify(data, null, 2));
  }

  return (
    <main>
      <form onSubmit={uploadCsv}>
        <input
          type="file"
          accept=".csv"
          onChange={(event) => setFile(event.target.files[0])}
        />
        <button type="submit">Upload CSV</button>
      </form>

      {jobId && <button onClick={checkJob}>Check Job</button>}

      <pre>{status}</pre>
    </main>
  );
}
```

## How To Run The Full Project

From the project root:

```bash
docker compose up -d
```

Create the PostgreSQL table:

```bash
docker exec -it bullmq-postgres psql -U bullmq -d bullmq_test
```

Then run:

```sql
CREATE TABLE IF NOT EXISTS csv_records (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  age INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Start API:

```bash
cd server
npm run dev
```

Start worker in another terminal:

```bash
cd worker
npm run dev
```

Start frontend in another terminal:

```bash
cd client
npm run dev
```

Open:

```txt
Frontend:   http://localhost:3000
API:        http://localhost:8000
Bull Board: http://localhost:8000/admin/queues
```

## Test Without Frontend

Create `sample.csv`:

```csv
name,email,age
Aayush,aayush@example.com,22
Riya,riya@example.com,24
```

Upload:

```bash
curl -X POST http://localhost:8000/upload \
  -F "file=@sample.csv"
```

Check job:

```bash
curl http://localhost:8000/jobs/JOB_ID_HERE
```

Check database:

```bash
docker exec -it bullmq-postgres psql -U bullmq -d bullmq_test
```

```sql
SELECT * FROM csv_records;
```

## Common Errors

`Cannot find module src/index.js`

Fix `server/package.json`:

```json
"dev": "nodemon index.js",
"start": "node index.js"
```

`relation "csv_records" does not exist`

Create the table in PostgreSQL using the SQL from the Database Setup section.

`ECONNREFUSED 127.0.0.1:6380`

Redis is not running. Start Docker:

```bash
docker compose up -d
```

`ECONNREFUSED 127.0.0.1:5433`

PostgreSQL is not running or the port is wrong. Check:

```bash
docker ps
```

`Only CSV files are allowed`

Upload a file ending with `.csv`.

## Learning Summary

By the end, you should understand:

- Redis stores jobs for BullMQ.
- The API is the producer because it adds jobs.
- The worker is the consumer because it processes jobs.
- PostgreSQL stores final processed data.
- Jobs can complete, fail, retry, and report progress.
- Concurrency lets one worker process multiple jobs.
- Bull Board gives a UI for queue debugging.

