// Project routes for Lookbook API
// Following the platform server pattern

const express = require('express');
const router = express.Router();
const projectQueries = require('../queries/projectQueries');
const { pool } = require('../db/dbConfig');
const { processBase64Image, isBase64Image } = require('../utils/imageConverter');
const { verifyAdminToken, isAdminRequest } = require('./auth');
const { clearInitiativeCache } = require('./initiatives');

// Simple in-memory cache for projects (to reduce database load)
const projectCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes (projects don't change frequently)

function getCacheKey(filters) {
  return JSON.stringify({
    search: filters.search || '',
    skills: (filters.skills || []).sort().join(','),
    sectors: (filters.sectors || []).sort().join(','),
    cohort: filters.cohort || '',
    excludeAmbassadors: filters.excludeAmbassadors || false,
    hasDemoVideo: filters.hasDemoVideo,
    status: filters.status || 'active',
    excludeHiddenInitiatives: filters.excludeHiddenInitiatives || false,
    limit: filters.limit || 50,
    offset: filters.offset || 0,
    includeParticipants: filters.includeParticipants || false
  });
}

function getCachedProjects(cacheKey) {
  const cached = projectCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedProjects(cacheKey, data) {
  projectCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
}

function invalidateProjectCache() {
  projectCache.clear();
  console.log('🗑️  Project cache cleared');
}

async function replaceExternalContributors(client, projectId, externalContributors = []) {
  await client.query('DELETE FROM lookbook_project_external_contributors WHERE project_id = $1', [projectId]);

  for (let i = 0; i < externalContributors.length; i++) {
    const contributor = externalContributors[i];
    if (!contributor) continue;

    const contributorId = typeof contributor === 'number' ? contributor :
      (contributor.external_contributor_id || contributor.externalContributorId || contributor.id);
    const role = typeof contributor === 'object' && contributor !== null ? (contributor.role || '') : '';

    if (contributorId) {
      await client.query(`
        INSERT INTO lookbook_project_external_contributors (
          project_id, external_contributor_id, role, display_order
        ) VALUES ($1, $2, $3, $4)
      `, [projectId, contributorId, role, i]);
    }
  }
}

// =====================================================
// GET /api/projects
// Get all projects with optional filtering
// =====================================================

router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      skills, 
      sectors, 
      cohort, 
      hasDemoVideo, 
      status,
      excludeAmbassadors,
      limit, 
      offset, 
      page 
    } = req.query;
    
    // Parse filters
    // includeParticipants defaults to false for performance (only include when explicitly requested)
    const includeParticipants = req.query.includeParticipants === 'true';

    // Only admins may see non-active projects (drafts/archived).
    // Public callers always get status='active' regardless of what they request.
    const requestedStatus = status || 'active';
    const admin = isAdminRequest(req);
    const effectiveStatus = requestedStatus !== 'active' && !admin
      ? 'active'
      : requestedStatus;

    const filters = {
      search,
      skills: skills ? (Array.isArray(skills) ? skills : skills.split(',')) : undefined,
      sectors: sectors ? (Array.isArray(sectors) ? sectors : sectors.split(',')) : undefined,
      cohort,
      excludeAmbassadors: excludeAmbassadors === 'true' || excludeAmbassadors === true,
      hasDemoVideo: hasDemoVideo === 'true' ? true : hasDemoVideo === 'false' ? false : undefined,
      status: effectiveStatus,
      // Public callers never see projects belonging to a hidden initiative.
      // Admins bypass so drafts/previews stay visible in admin tooling.
      excludeHiddenInitiatives: !admin,
      limit: parseInt(limit) || 50,
      offset: page ? (parseInt(page) - 1) * (parseInt(limit) || 50) : parseInt(offset) || 0,
      includeParticipants // Only include participants when explicitly requested (for detail views)
    };
    
    // Check cache first
    const cacheKey = getCacheKey(filters);
    const cachedResult = getCachedProjects(cacheKey);
    if (cachedResult) {
      console.log(`📦 Cache HIT for projects query`);
      res.set('Cache-Control', 'no-cache');
      return res.json({
        success: true,
        data: cachedResult.projects,
        pagination: {
          total: cachedResult.total,
          limit: cachedResult.limit,
          offset: cachedResult.offset,
          page: Math.floor(cachedResult.offset / cachedResult.limit) + 1,
          totalPages: Math.ceil(cachedResult.total / cachedResult.limit)
        }
      });
    }
    
    // Cache miss - fetch from database
    console.log(`📦 Cache MISS for projects query - fetching from database`);
    const startTime = Date.now();
    
    let result;
    try {
      result = await projectQueries.getAllProjects(filters);
      const queryTime = Date.now() - startTime;
      
      // Cache the result (only if successful)
      setCachedProjects(cacheKey, result);
      
      console.log(`✅ Fetched ${result.projects.length} projects in ${queryTime}ms (cached for next request)`);

      res.set('Cache-Control', 'no-cache');
      res.json({
        success: true,
        data: result.projects,
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset,
          page: Math.floor(result.offset / result.limit) + 1,
          totalPages: Math.ceil(result.total / result.limit)
        }
      });
    } catch (error) {
      const queryTime = Date.now() - startTime;
      console.error(`❌ Error fetching projects after ${queryTime}ms:`, error.message);
      
      // If timeout, check if we have stale cache we can serve
      if (error.message.includes('timeout') || error.message.includes('TIMEOUT')) {
        const staleCache = projectCache.get(cacheKey);
        if (staleCache) {
          console.log(`⚠️  Serving stale cache due to timeout (${Math.floor((Date.now() - staleCache.timestamp) / 1000)}s old)`);
          return res.json({
            success: true,
            data: staleCache.data.projects,
            pagination: {
              total: staleCache.data.total,
              limit: staleCache.data.limit,
              offset: staleCache.data.offset,
              page: Math.floor(staleCache.data.offset / staleCache.data.limit) + 1,
              totalPages: Math.ceil(staleCache.data.total / staleCache.data.limit)
            },
            _cached: true,
            _stale: true
          });
        }
      }
      
      res.status(500).json({ 
        success: false,
        error: 'Failed to fetch projects',
        message: error.message 
      });
    }
  } catch (error) {
    console.error('Error in projects route:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch projects',
      message: error.message 
    });
  }
});

// =====================================================
// GET /api/projects/filters
// Get available filter options
// =====================================================

router.get('/filters', async (req, res) => {
  try {
    const [skills, sectors, cohorts] = await Promise.all([
      projectQueries.getAllSkills(),
      projectQueries.getAllSectors(),
      projectQueries.getAllCohorts()
    ]);
    
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      success: true,
      data: {
        skills,
        sectors,
        cohorts
      }
    });
  } catch (error) {
    console.error('Error fetching filter options:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch filter options',
      message: error.message 
    });
  }
});

// =====================================================
// GET /api/projects/:slug
// Get single project by slug
// =====================================================

router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const project = await projectQueries.getProjectBySlug(slug);
    const admin = isAdminRequest(req);

    // Non-active (draft/archived) projects, and any project whose initiative is
    // hidden, are only visible to admins. A hidden initiative overrides the
    // project's own (active) status for public visitors.
    if (!project || ((project.status !== 'active' || project.initiative_hidden) && !admin)) {
      return res.status(404).json({ 
        success: false,
        error: 'Project not found' 
      });
    }
    
    res.set('Cache-Control', 'no-cache');
    res.json({
      success: true,
      data: project
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch project',
      message: error.message 
    });
  }
});

// =====================================================
// POST /api/projects
// Create new project
// TODO: Add authentication middleware
// =====================================================

router.post('/', async (req, res) => {
  try {
    const projectData = req.body;

    // Basic validation
    if (!projectData.slug || !projectData.title) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: slug, title'
      });
    }

    // Validate slug format (only lowercase letters, numbers, and hyphens)
    const slug = projectData.slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid slug format. Use only lowercase letters, numbers, and hyphens (e.g., "my-project-name")'
      });
    }
    projectData.slug = slug;

    // Separate participants from other project data
    const { participants, externalContributors, ...projectFields } = projectData;

    const imageFields = ['main_image_url', 'card_background_url', 'partner_logo_url', 'icon_url'];
    for (const field of imageFields) {
      if (isBase64Image(projectFields[field])) {
        const opts = field === 'icon_url' ? { maxWidth: 256, quality: 85 } : { maxWidth: 1200, quality: 82 };
        const result = await processBase64Image(projectFields[field], 'projects', `${slug}-`, opts);
        projectFields[field] = result.url;
      }
    }

    // Create the project first
    const newProject = await projectQueries.createProject(projectFields);

    // Save participants if provided (best effort — project is already created)
    if (participants && Array.isArray(participants) && participants.length > 0) {
      for (let i = 0; i < participants.length; i++) {
        const participant = participants[i];
        if (!participant) continue;
        const profileId = typeof participant === 'number' ? participant :
          (participant.profile_id || participant.profileId || participant.id);
        if (profileId) {
          const role = typeof participant === 'object' && participant !== null ? (participant.role || '') : '';
          await pool.query(`
            INSERT INTO lookbook_project_participants (project_id, profile_id, role, display_order)
            VALUES ($1, $2, $3, $4)
          `, [newProject.id, profileId, role, i]);
        }
      }
    }

    if (externalContributors && Array.isArray(externalContributors) && externalContributors.length > 0) {
      const client = await pool.connect();
      try {
        await replaceExternalContributors(client, newProject.id, externalContributors);
      } finally {
        client.release();
      }
    }

    // Invalidate server-side list cache
    projectCache.clear();
    clearInitiativeCache();

    res.status(201).json({
      success: true,
      data: newProject,
      message: 'Project created successfully'
    });
  } catch (error) {
    console.error('Error creating project:', error);
    
    // Handle duplicate constraint errors
    if (error.code === '23505') {
      const errorMessage = error.message || '';
      if (errorMessage.includes('slug') || errorMessage.includes('lookbook_projects_slug_key')) {
        return res.status(409).json({
          success: false,
          error: 'Project with this slug already exists'
        });
      }
      return res.status(409).json({
        success: false,
        error: 'A project with this information already exists'
      });
    }
    
    // Handle not null constraint errors
    if (error.code === '23502') {
      const column = error.column || 'unknown field';
      return res.status(400).json({
        success: false,
        error: `Missing required field: ${column}`
      });
    }
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to create project',
      message: error.message 
    });
  }
});

// =====================================================
// PUT /api/projects/:slug
// Update project
// TODO: Add authentication middleware
// =====================================================

router.put('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const updates = req.body;
    
    // Separate participants from other updates
    const { participants, externalContributors, ...projectUpdates} = updates;
    
    // Map camelCase to snake_case for backwards compatibility
    if (projectUpdates.shortDescription !== undefined) {
      projectUpdates.short_description = projectUpdates.shortDescription;
      delete projectUpdates.shortDescription;
    }
    
    // Map card background URL from camelCase to snake_case
    if (projectUpdates.cardBackgroundUrl !== undefined) {
      projectUpdates.card_background_url = projectUpdates.cardBackgroundUrl;
      delete projectUpdates.cardBackgroundUrl;
    }
    
    // Map card background video URL from camelCase to snake_case
    if (projectUpdates.cardBackgroundVideoUrl !== undefined) {
      projectUpdates.card_background_video_url = projectUpdates.cardBackgroundVideoUrl;
      delete projectUpdates.cardBackgroundVideoUrl;
    }
    
    // Map partner fields from camelCase to snake_case
    if (projectUpdates.hasPartner !== undefined) {
      projectUpdates.has_partner = projectUpdates.hasPartner;
      delete projectUpdates.hasPartner;
    }
    if (projectUpdates.partnerName !== undefined) {
      projectUpdates.partner_name = projectUpdates.partnerName;
      delete projectUpdates.partnerName;
    }
    if (projectUpdates.partnerLogoUrl !== undefined) {
      projectUpdates.partner_logo_url = projectUpdates.partnerLogoUrl;
      delete projectUpdates.partnerLogoUrl;
    }
    
    // Process any base64 images to optimized WebP files
    const imageFields = ['main_image_url', 'card_background_url', 'partner_logo_url', 'icon_url'];
    for (const field of imageFields) {
      if (isBase64Image(projectUpdates[field])) {
        const opts = field === 'icon_url' ? { maxWidth: 256, quality: 85 } : { maxWidth: 1200, quality: 82 };
        const result = await processBase64Image(projectUpdates[field], 'projects', `${slug}-`, opts);
        projectUpdates[field] = result.url;
      }
    }

    const client = await pool.connect();
    let updatedProject;
    try {
      await client.query('BEGIN');

      // Update the project
      updatedProject = await projectQueries.updateProject(slug, projectUpdates);

      if (!updatedProject) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      // If participants data is provided, replace them atomically
      if (participants && Array.isArray(participants)) {
        await client.query('DELETE FROM lookbook_project_participants WHERE project_id = $1', [updatedProject.id]);

        for (let i = 0; i < participants.length; i++) {
          const participant = participants[i];
          if (!participant) continue;

          const profileId = typeof participant === 'number' ? participant :
            (participant.profile_id || participant.profileId || participant.id);
          const role = typeof participant === 'object' && participant !== null ? (participant.role || '') : '';

          if (profileId) {
            await client.query(`
              INSERT INTO lookbook_project_participants (project_id, profile_id, role, display_order)
              VALUES ($1, $2, $3, $4)
            `, [updatedProject.id, profileId, role, i]);
          }
        }
      }

      if (externalContributors && Array.isArray(externalContributors)) {
        await replaceExternalContributors(client, updatedProject.id, externalContributors);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Invalidate server-side list cache so stale data isn't served
    projectCache.clear();
    clearInitiativeCache();

    res.json({
      success: true,
      data: updatedProject,
      message: 'Project updated successfully'
    });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update project',
      message: error.message 
    });
  }
});

// =====================================================
// POST /api/projects/:slug/publish
// Publish a draft project (set status to active) - admin only
// =====================================================

router.post('/:slug/publish', verifyAdminToken, async (req, res) => {
  try {
    const { slug } = req.params;
    const updatedProject = await projectQueries.updateProject(slug, { status: 'active' });

    if (!updatedProject) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    projectCache.clear();
    clearInitiativeCache();

    res.json({
      success: true,
      data: updatedProject,
      message: 'Project published successfully'
    });
  } catch (error) {
    console.error('Error publishing project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to publish project',
      message: error.message
    });
  }
});

// =====================================================
// POST /api/projects/:slug/unpublish
// Move a published project back to draft - admin only
// =====================================================

router.post('/:slug/unpublish', verifyAdminToken, async (req, res) => {
  try {
    const { slug } = req.params;
    const updatedProject = await projectQueries.updateProject(slug, { status: 'draft' });

    if (!updatedProject) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    projectCache.clear();
    clearInitiativeCache();

    res.json({
      success: true,
      data: updatedProject,
      message: 'Project moved back to draft'
    });
  } catch (error) {
    console.error('Error unpublishing project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to unpublish project',
      message: error.message
    });
  }
});

// =====================================================
// DELETE /api/projects/by-id/:id
// Delete project by ID (for cases where slug is malformed)
// TODO: Add authentication middleware
// =====================================================

router.delete('/by-id/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID'
      });
    }

    const deletedProject = await projectQueries.deleteProjectById(id);

    if (!deletedProject) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    projectCache.clear();
    clearInitiativeCache();

    res.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting project by ID:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete project',
      message: error.message
    });
  }
});

// =====================================================
// DELETE /api/projects/:slug
// Delete project
// TODO: Add authentication middleware
// =====================================================

router.delete('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const deletedProject = await projectQueries.deleteProject(slug);
    
    if (!deletedProject) {
      return res.status(404).json({ 
        success: false,
        error: 'Project not found' 
      });
    }

    projectCache.clear();
    clearInitiativeCache();
    
    res.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete project',
      message: error.message 
    });
  }
});

// =====================================================
// POST /api/projects/:slug/participants
// Add participant to project
// TODO: Add authentication middleware
// =====================================================

router.post('/:slug/participants', async (req, res) => {
  try {
    const { slug } = req.params;
    const { profileSlug, role, displayOrder } = req.body;
    
    // Get project and profile IDs
    const project = await projectQueries.getProjectBySlug(slug);
    if (!project) {
      return res.status(404).json({ 
        success: false,
        error: 'Project not found' 
      });
    }
    
    // For now, we need to import profile queries to get profile ID
    const profileQueries = require('../queries/profileQueries');
    const profile = await profileQueries.getProfileBySlug(profileSlug);
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const participant = await projectQueries.addParticipant(
      project.id,
      profile.id,
      role,
      displayOrder || 0
    );
    
    res.status(201).json({
      success: true,
      data: participant,
      message: 'Participant added successfully'
    });
  } catch (error) {
    console.error('Error adding participant:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to add participant',
      message: error.message 
    });
  }
});

// =====================================================
// DELETE /api/projects/:slug/participants/:profileSlug
// Remove participant from project
// TODO: Add authentication middleware
// =====================================================

router.delete('/:slug/participants/:profileSlug', async (req, res) => {
  try {
    const { slug, profileSlug } = req.params;
    
    // Get project and profile IDs
    const project = await projectQueries.getProjectBySlug(slug);
    if (!project) {
      return res.status(404).json({ 
        success: false,
        error: 'Project not found' 
      });
    }
    
    const profileQueries = require('../queries/profileQueries');
    const profile = await profileQueries.getProfileBySlug(profileSlug);
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    await projectQueries.removeParticipant(project.id, profile.id);
    
    res.json({
      success: true,
      message: 'Participant removed successfully'
    });
  } catch (error) {
    console.error('Error removing participant:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to remove participant',
      message: error.message 
    });
  }
});

module.exports = router;
// Allow other routes (e.g. initiative visibility toggles) to invalidate the
// project cache so hidden/shown initiatives reflect in project listings.
module.exports.clearProjectCache = invalidateProjectCache;


