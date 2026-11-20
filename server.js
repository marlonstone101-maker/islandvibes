const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files (HTML, CSS, JS, images, videos)
app.use(express.static(path.join(__dirname)));

// API Health Check Route
app.get('/api/health', (req, res) => {
    res.status(200).json({ 
        status: 'online', 
        message: 'Island Vibz Seafood backend is running successfully!',
        timestamp: new Date().toISOString()
    });
});

// Catch-all route to serve index.html for single-page layout handling
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`Island Vibz backend server running locally on http://localhost:${PORT}`);
});