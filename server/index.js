const express = require('express');
const pool = require('./db');

const app = express();

app.use(express.json());

app.get("/", (req,res) => {
    res.json({
        message: "Server is running"
    })
});

app.post("/records", async(req,res) => {
    try{
        const  { name, email, age } = req.body;
        const results = await pool.query(`
            INSERT INTO csv_records (name, email, age)
            VALUES ($1, $2, $3)
            RETURNING *
        `,[name, email, age]) 
        res.status(201).json({
            message:'Records Inserted Succesfully',
            records: results.rows[0],
        })
    } catch (error){
        console.error("Database error", error);

        res.status(500).json({ message: "Failed to  insert records"})
    }
})

const port = process.env.PORT ;

app.listen(port, ()=>{
    console.log(`Server is running on Port ${port}`)
})
