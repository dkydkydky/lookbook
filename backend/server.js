// Lookbook Backend Server
// Express + PostgreSQL API following test-pilot-server patterns

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { pool } = require('./db/dbConfig');
const { ensureUploadsRoot, DEFAULT_UPLOADS_ROOT } = require('./utils/uploadPaths');

const app = express();
const PORT = process.env.PORT || 4002; // Default to 4002 to match frontend

// =====================================================
// MIDDLEWARE
// =====================================================

// Enable gzip compression for all responses
app.use(compression({
  // Compress all responses
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  },
  // Compression level (0-9, 6 is default, 9 is best but slowest)
  level: 6
}));

// CORS configuration - more flexible for development
const stripWww = (hostname = '') => hostname.replace(/^www\./i, '');

const parseOrigin = (originValue) => {
  try {
    return new URL(originValue);
  } catch {
    return null;
  }
};

const isAllowedOrigin = (origin, allowedOrigins) => {
  const requestOrigin = parseOrigin(origin);
  if (!requestOrigin) return false;

  return allowedOrigins.some((allowedOriginValue) => {
    const allowedOrigin = parseOrigin(allowedOriginValue);
    if (!allowedOrigin) return false;

    const sameProtocol = requestOrigin.protocol === allowedOrigin.protocol;
    const samePort = requestOrigin.port === allowedOrigin.port;
    const sameBaseHostname = stripWww(requestOrigin.hostname) === stripWww(allowedOrigin.hostname);

    return sameProtocol && samePort && sameBaseHostname;
  });
};

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // In development, allow any localhost port
    if (process.env.NODE_ENV !== 'production') {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }
    
    // In production, allow configured frontend URL(s) and Render preview URLs
    const allowedOrigins = process.env.FRONTEND_URL ? 
      process.env.FRONTEND_URL.split(',').map((value) => value.trim()).filter(Boolean) : 
      ['http://localhost:5175', 'http://localhost:5176'];
    
    // Also allow any .onrender.com domain in production (for Render deployments)
    if (process.env.NODE_ENV === 'production' && origin && origin.includes('.onrender.com')) {
      return callback(null, true);
    }
    
    if (isAllowedOrigin(origin, allowedOrigins)) {
      callback(null, true);
    } else {
      // Log rejected origins in production for debugging
      if (process.env.NODE_ENV === 'production') {
        console.log('CORS rejected origin:', origin);
      }
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

// Apply browser CORS to everything except the remote MCP connector. MCP calls
// are server-to-server / native-client (not browser fetches), are gated by the
// secret URL, and can carry an Origin the strict production CORS would reject —
// so skip CORS there to avoid false "connection issue" failures.
app.use((req, res, next) => {
  if (req.path.startsWith('/mcp/')) return next();
  return cors(corsOptions)(req, res, next);
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const uploadsRoot = ensureUploadsRoot();

// Serve static files from uploads directory (for uploaded images)
// Cache images aggressively in the browser - 7 days
const staticOpts = { maxAge: '7d', etag: true, lastModified: true };
app.use('/uploads', express.static(uploadsRoot, staticOpts));

// Fallback: serve repo-bundled uploads when a file isn't on the runtime disk.
// In production UPLOADS_ROOT points at a persistent disk, so files committed to
// backend/public/uploads (version-controlled defaults) are still served if the
// disk doesn't have them — they ship with the deploy and can't silently vanish.
if (DEFAULT_UPLOADS_ROOT !== uploadsRoot) {
  app.use('/uploads', express.static(DEFAULT_UPLOADS_ROOT, staticOpts));
}

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// =====================================================
// ROUTES
// =====================================================

// Health check
app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'lookbook-api'
  });
});

// Test database connection
app.get('/api/health/db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'connected',
      timestamp: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

// Import route modules
const authRouter = require('./routes/auth');
const profilesRouter = require('./routes/profiles');
const projectsRouter = require('./routes/projects');
const searchRouter = require('./routes/search');
const sharepackRouter = require('./routes/sharepack');
const aiRouter = require('./routes/ai');
const taxonomyRouter = require('./routes/taxonomy');
const initiativesRouter = require('./routes/initiatives');
const externalContributorsRouter = require('./routes/externalContributors');
const imageProxyRouter = require('./routes/imageProxy');
const contactRouter = require('./routes/contact');

// Mount routes
app.use('/api/auth', authRouter);

// Pre-warm cache on startup (for faster initial loads)
async function preWarmCache() {
  const http = require('http');

  // Helper to make a cache-warming request
  const warmRequest = (url, description) => {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const testRequest = http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const warmTime = Date.now() - startTime;
          try {
            const result = JSON.parse(data);
            if (result.success) {
              console.log(`   ✓ ${description} cached in ${warmTime}ms (${result.data?.length || 0} items)`);
            }
          } catch (e) {
            // Ignore parse errors
          }
          resolve();
        });
      });
      testRequest.on('error', () => resolve());
      testRequest.setTimeout(15000, () => {
        testRequest.destroy();
        resolve();
      });
    });
  };

  try {
    console.log('🔥 Pre-warming project cache...');
    const startTime = Date.now();

    // 1. Warm default projects query
    await warmRequest(
      `http://localhost:${PORT}/api/projects?limit=8&offset=0&includeParticipants=false`,
      'Default projects (first page)'
    );

    // 2. Warm initiative cohort filters
    try {
      const { pool } = require('./db/dbConfig');
      const initiativesResult = await pool.query(
        'SELECT DISTINCT cohort_value FROM lookbook_initiatives WHERE is_active = true AND cohort_value IS NOT NULL'
      );

      if (initiativesResult.rows.length > 0) {
        console.log(`   Warming ${initiativesResult.rows.length} initiative cohorts...`);
        for (const row of initiativesResult.rows) {
          const cohort = row.cohort_value;
          await warmRequest(
            `http://localhost:${PORT}/api/projects?limit=8&offset=0&cohort=${encodeURIComponent(cohort)}&includeParticipants=false`,
            `Cohort: ${cohort}`
          );
        }
      }
    } catch (dbErr) {
      console.warn('   ⚠️  Could not warm initiative caches:', dbErr.message);
    }

    const totalTime = Date.now() - startTime;
    console.log(`✅ Cache pre-warming completed in ${totalTime}ms`);
  } catch (error) {
    console.warn('⚠️  Cache pre-warming failed (non-critical):', error.message);
  }
}

// Pre-warm cache after server starts (don't block startup)
setTimeout(preWarmCache, 3000); // Wait 3 seconds for server to fully start
app.use('/api/profiles', profilesRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/search', searchRouter);
app.use('/api/sharepack', sharepackRouter);
app.use('/api/ai', aiRouter);
app.use('/api/taxonomy', taxonomyRouter);
app.use('/api/initiatives', initiativesRouter);
app.use('/api/external-contributors', externalContributorsRouter);
app.use('/api/image-proxy', imageProxyRouter);
app.use('/api/contact', contactRouter);

// =====================================================
// REMOTE MCP CONNECTOR (optional)
// =====================================================
// Serves the Lookbook tools over Streamable HTTP so Claude can add this as a
// remote connector. Gated behind a secret URL segment (MCP_SECRET) so the
// endpoint isn't guessable. Read-only by default; set MCP_ENABLE_WRITES=true to
// expose write/upload tools (not recommended for a public endpoint).
const MCP_SECRET = process.env.MCP_SECRET;
if (MCP_SECRET) {
  const mcpEnableWrites = process.env.MCP_ENABLE_WRITES === 'true';
  const mcpAllowDelete = process.env.MCP_ALLOW_DELETE === 'true';
  const mcpBaseUrl = process.env.MCP_BASE_URL || `http://localhost:${PORT}/api`;

  // Lazily build the handler on first use (the MCP SDK is ES-module only, so we
  // load it via dynamic import from this CommonJS file).
  let mcpHandlerPromise = null;
  const getMcpHandler = () => {
    if (!mcpHandlerPromise) {
      mcpHandlerPromise = import('./mcp/httpConnector.js').then(({ createHttpHandler }) =>
        createHttpHandler({
          baseUrl: mcpBaseUrl,
          enableWrites: mcpEnableWrites,
          allowDelete: mcpAllowDelete,
          auth: {
            token: process.env.ADMIN_TOKEN,
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD,
          },
        })
      );
    }
    return mcpHandlerPromise;
  };

  app.all('/mcp/:secret', async (req, res) => {
    // Constant-ish check; mismatch looks like any other 404 to avoid probing.
    if (req.params.secret !== MCP_SECRET) {
      return res.status(404).json({ error: 'Not Found', path: req.path });
    }
    try {
      const handler = await getMcpHandler();
      await handler(req, res);
    } catch (error) {
      console.error('MCP connector error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP connector error', message: error.message });
      }
    }
  });

  console.log('🔌 Remote MCP connector enabled at /mcp/<secret> (writes ' + (mcpEnableWrites ? 'on' : 'off') + ')');
}

// =====================================================
// ERROR HANDLING
// =====================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    path: req.path 
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// =====================================================
// SERVER START
// =====================================================

const server = app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🚀 Lookbook API Server Running        ║
║                                          ║
║   Port: ${PORT}                            ║
║   Environment: ${process.env.NODE_ENV || 'development'}              ║
║   Frontend: ${process.env.FRONTEND_URL || 'http://localhost:5173'}   ║
║                                          ║
║   Ready to accept requests! 🎉          ║
╚══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    pool.end(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});


