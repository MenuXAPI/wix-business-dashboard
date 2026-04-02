const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Allow embedding in Wix Dashboard iframe
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
      next();
      });

      // Dashboard plugin page
      app.get('/dashboard', (req, res) => {
        res.send(`<!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Business Setup Dashboard</title>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                        body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #f5f5f5; color: #333; }
                            .container { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
                                h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; color: #111; }
                                    p.subtitle { color: #666; font-size: 14px; margin-bottom: 32px; }
                                        .card { background: white; border-radius: 8px; padding: 24px; margin-bottom: 16px; border: 1px solid #e5e5e5; }
                                            .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
                                                .btn { display: inline-block; background: #116dff; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; cursor: pointer; }
                                                    .btn:hover { background: #0d5ce0; }
                                                        .status { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 12px; background: #e8f5e9; color: #2e7d32; margin-bottom: 16px; }
                                                          </style>
                                                          </head>
                                                          <body>
                                                            <div class="container">
                                                                <h1>Business Setup</h1>
                                                                    <p class="subtitle">AI-powered business data import and management</p>
                                                                        <span class="status">Connected</span>
                                                                            <div class="card">
                                                                                  <h2>Connect Your Business</h2>
                                                                                        <p style="font-size:14px;color:#666;margin-bottom:16px;">Enter your business name or Google Place ID to import your business data automatically.</p>
                                                                                              <input type="text" placeholder="e.g. Joe's Pizza, New York" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:12px;" />
                                                                                                    <button class="btn">Import Business Data</button>
                                                                                                        </div>
                                                                                                            <div class="card">
                                                                                                                  <h2>Menu Data</h2>
                                                                                                                        <p style="font-size:14px;color:#666;">No menu data imported yet. Connect your business above to get started.</p>
                                                                                                                            </div>
                                                                                                                                <div class="card">
                                                                                                                                      <h2>Photos</h2>
                                                                                                                                            <p style="font-size:14px;color:#666;">No photos imported yet.</p>
                                                                                                                                                </div>
                                                                                                                                                  </div>
                                                                                                                                                  </body>
                                                                                                                                                  </html>`);
                                                                                                                                                  });
                                                                                                                                                  
                                                                                                                                                  // Health check
                                                                                                                                                  app.get('/', (req, res) => {
                                                                                                                                                    res.json({ status: 'ok', service: 'wix-business-dashboard' });
                                                                                                                                                    });
                                                                                                                                                    
                                                                                                                                                    app.listen(PORT, () => {
                                                                                                                                                      console.log('Wix Business Dashboard running on port ' + PORT);
                                                                                                                                                      });
