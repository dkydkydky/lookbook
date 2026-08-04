// Project queries for Lookbook
// Follows the platform server query pattern

const { pool } = require('../db/dbConfig');

// =====================================================
// GET ALL PROJECTS
// =====================================================

const getAllProjects = async (filters = {}) => {
  const {
    search,
    skills,
    sectors,
    cohort,
    hasDemoVideo,
    status = 'active',
    limit = 50,
    offset = 0,
    excludeAmbassadors = false,
    includeParticipants = false, // New flag to optionally include participants
    excludeHiddenInitiatives = false // When true, hide projects whose cohort belongs to a hidden (is_active=false) initiative
  } = filters;
  
  // Build participants subquery only if requested
  const participantsQuery = includeParticipants ? `
    (
      SELECT json_agg(participant ORDER BY display_order, sort_name)
      FROM (
        SELECT
          pp.display_order,
          COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(prof.slug, '-', ' '))) as sort_name,
          json_build_object(
            'type', 'profile',
            'profile_id', prof.id,
            'slug', prof.slug,
            'name', COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(prof.slug, '-', ' '))),
            'photoUrl', prof.photo_url,
            'role', pp.role
          ) as participant
        FROM lookbook_project_participants pp
        JOIN lookbook_profiles prof ON pp.profile_id = prof.id
        LEFT JOIN users u ON prof.user_id = u.user_id
        WHERE pp.project_id = p.id

        UNION ALL

        SELECT
          pec.display_order,
          ec.name as sort_name,
          json_build_object(
            'type', 'external',
            'external_contributor_id', ec.id,
            'name', ec.name,
            'title', ec.title,
            'organization', ec.organization,
            'photoUrl', ec.photo_url,
            'role', pec.role
          ) as participant
        FROM lookbook_project_external_contributors pec
        JOIN lookbook_external_contributors ec ON pec.external_contributor_id = ec.id
        WHERE pec.project_id = p.id
      ) team_members
    ) as participants,
  ` : `NULL as participants,`;
  
  // Build WHERE clause conditions
  // status 'all' (admin-only, enforced at route level) skips the status filter
  const whereConditions = [];
  const params = [];
  let paramCount = 1;

  if (status !== 'all') {
    whereConditions.push(`p.status = $${paramCount}`);
    params.push(status);
    paramCount++;
  }
  
  // Text search (title, summary) - use index-friendly search if possible
  if (search) {
    whereConditions.push(`(
      p.title ILIKE $${paramCount} OR 
      p.summary ILIKE $${paramCount}
    )`);
    params.push(`%${search}%`);
    paramCount++;
  }
  
  // Skills filter (must have ALL specified skills) - uses GIN index
  if (skills && skills.length > 0) {
    whereConditions.push(`p.skills @> $${paramCount}::text[]`);
    params.push(skills);
    paramCount++;
  }
  
  // Sectors filter (must have ALL specified sectors) - uses GIN index
  if (sectors && sectors.length > 0) {
    whereConditions.push(`p.sectors @> $${paramCount}::text[]`);
    params.push(sectors);
    paramCount++;
  }
  
  // Cohort filter - uses index
  if (cohort) {
    if (cohort === 'earlier') {
      whereConditions.push(`(p.cohort < '2021' OR p.cohort IS NULL)`);
    } else {
      whereConditions.push(`p.cohort = $${paramCount}`);
      params.push(cohort);
      paramCount++;
    }
  }

  if (excludeAmbassadors) {
    whereConditions.push(`(
      p.cohort IS DISTINCT FROM 'UFT AI Ambassadors'
      AND (
        p.summary IS NULL
        OR p.summary NOT LIKE '{%"ambassador_name"%'
      )
    )`);
  }
  
  // Has demo video filter
  if (hasDemoVideo !== undefined) {
    whereConditions.push(`(p.demo_video_url IS ${hasDemoVideo ? 'NOT NULL' : 'NULL'})`);
  }

  // Initiative-level visibility override: a hidden initiative (is_active=false)
  // suppresses ALL of its projects publicly, regardless of each project's own
  // status. Admins skip this (excludeHiddenInitiatives=false) so they can preview.
  if (excludeHiddenInitiatives) {
    whereConditions.push(`NOT EXISTS (
      SELECT 1 FROM lookbook_initiatives li
      WHERE li.cohort_value = p.cohort AND li.is_active = false
    )`);
  }
  
  const whereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : 'TRUE';
  
  // Optimize ORDER BY clause: When filtering by cohort, ensure we use the composite index
  // The composite index (status, cohort, created_at DESC) can satisfy both WHERE and ORDER BY
  // PostgreSQL will automatically use the most efficient index available
  const orderByClause = 'ORDER BY p.created_at DESC';
  
  // Use window function for count (faster than CTE for large datasets)
  // This avoids materializing the entire CTE before counting
  // When cohort filter is present, PostgreSQL can use idx_lookbook_projects_active_cohort_created
  const dataQuery = `
    SELECT 
      p.id as project_id,
      p.slug,
      p.title,
      p.summary,
      p.short_description,
      p.skills,
      p.sectors,
      p.main_image_url,
      p.card_background_url,
      p.card_background_video_url,
      p.icon_url,
      p.demo_video_url,
      p.github_url,
      p.live_url,
      p.cohort,
      p.status,
      p.has_partner,
      p.partner_name,
      p.partner_logo_url,
      p.created_at,
      ${participantsQuery}
      (
        (SELECT COUNT(*)::int FROM lookbook_project_participants pp WHERE pp.project_id = p.id) +
        (SELECT COUNT(*)::int FROM lookbook_project_external_contributors pec WHERE pec.project_id = p.id)
      ) as participant_count,
      COUNT(*) OVER() as total_count
    FROM lookbook_projects p
    WHERE ${whereClause}
    ${orderByClause}
    LIMIT $${paramCount} OFFSET $${paramCount + 1}
  `;
  
  // Execute query with timeout protection
  const startTime = Date.now();
  
  // Create timeout promise (90 seconds for remote databases - network latency is the issue)
  // Note: This is high because of network latency to remote database, not query complexity
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Query timeout after 90 seconds')), 90000);
  });
  
  let result;
  try {
    // Execute single query with window function (faster than CTE for large result sets)
    result = await Promise.race([
      pool.query(dataQuery, [...params, limit, offset]),
      timeoutPromise
    ]);
  } catch (error) {
    const queryTime = Date.now() - startTime;
    if (error.message.includes('timeout')) {
      console.error(`❌ Query TIMEOUT after ${queryTime}ms - network latency issue`);
      throw new Error('Database query timed out. Please try again or contact support if this persists.');
    } else {
      console.error(`❌ Query failed after ${queryTime}ms:`, error.message);
      throw error;
    }
  }
  
  const queryTime = Date.now() - startTime;
  const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
  
  // Projects are already in the correct format
  const projects = result.rows;
  
  // Log slow queries (only warn for very slow queries)
  if (queryTime > 5000) {
    console.warn(`⚠️  SLOW QUERY: ${queryTime}ms for getAllProjects`);
    console.warn(`   Filters: search=${search || 'none'}, skills=${skills?.length || 0}, sectors=${sectors?.length || 0}, cohort=${cohort || 'none'}`);
    console.warn(`   Returned: ${projects.length} rows, total: ${total}`);
  } else if (queryTime > 1000) {
    console.log(`📊 getAllProjects query: ${queryTime}ms (${projects.length} rows, total: ${total})`);
  }
  
  return {
    projects,
    total,
    limit,
    offset
  };
};

// =====================================================
// GET PROJECT BY SLUG
// =====================================================

const getProjectBySlug = async (slug) => {
  const query = `
    SELECT 
      p.*,
      (
        SELECT json_agg(participant ORDER BY display_order, sort_name)
        FROM (
          SELECT
            pp.display_order,
            COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(prof.slug, '-', ' '))) as sort_name,
            json_build_object(
              'type', 'profile',
              'profile_id', prof.id,
              'slug', prof.slug,
              'name', COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(prof.slug, '-', ' '))),
              'title', prof.title,
              'photoUrl', prof.photo_url,
              'photoLqip', prof.photo_lqip,
              'role', pp.role
            ) as participant
          FROM lookbook_project_participants pp
          JOIN lookbook_profiles prof ON pp.profile_id = prof.id
          LEFT JOIN users u ON prof.user_id = u.user_id
          WHERE pp.project_id = p.id

          UNION ALL

          SELECT
            pec.display_order,
            ec.name as sort_name,
            json_build_object(
              'type', 'external',
              'external_contributor_id', ec.id,
              'name', ec.name,
              'title', ec.title,
              'organization', ec.organization,
              'photoUrl', ec.photo_url,
              'role', pec.role
            ) as participant
          FROM lookbook_project_external_contributors pec
          JOIN lookbook_external_contributors ec ON pec.external_contributor_id = ec.id
          WHERE pec.project_id = p.id
        ) team_members
      ) as participants,
      EXISTS (
        SELECT 1 FROM lookbook_initiatives li
        WHERE li.cohort_value = p.cohort AND li.is_active = false
      ) as initiative_hidden
    FROM lookbook_projects p
    WHERE p.slug = $1
  `;
  
  const result = await pool.query(query, [slug]);
  return result.rows[0] || null;
};

// =====================================================
// CREATE PROJECT
// =====================================================

const createProject = async (projectData) => {
  // Accept both snake_case (from frontend) and camelCase field names
  const slug = projectData.slug;
  const title = projectData.title;
  const summary = projectData.summary;
  const shortDescription = projectData.short_description || projectData.shortDescription;
  const description = projectData.description;
  const mainImageUrl = projectData.main_image_url || projectData.mainImageUrl;
  const mainImageLqip = projectData.main_image_lqip || projectData.mainImageLqip;
  const cardBackgroundUrl = projectData.card_background_url || projectData.cardBackgroundUrl;
  const cardBackgroundVideoUrl = projectData.card_background_video_url || projectData.cardBackgroundVideoUrl;
  const iconUrl = projectData.icon_url || projectData.iconUrl;
  const demoVideoUrl = projectData.demo_video_url || projectData.demoVideoUrl;
  const skills = projectData.skills || [];
  const sectors = projectData.sectors || [];
  const githubUrl = projectData.github_url || projectData.githubUrl;
  const liveUrl = projectData.live_url || projectData.liveUrl;
  const cohort = projectData.cohort;
  // New projects default to draft so they stay hidden from the public site until published
  const status = projectData.status || 'draft';
  const hasPartner = projectData.has_partner || projectData.hasPartner || false;
  const partnerName = projectData.partner_name || projectData.partnerName;
  const partnerLogoUrl = projectData.partner_logo_url || projectData.partnerLogoUrl;
  const backgroundColor = projectData.background_color || projectData.backgroundColor || '#6366f1';

  const query = `
    INSERT INTO lookbook_projects (
      slug, title, summary, short_description, description, main_image_url, main_image_lqip, card_background_url,
      card_background_video_url, icon_url, demo_video_url, skills, sectors, github_url, live_url, cohort, status,
      has_partner, partner_name, partner_logo_url, background_color
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
    RETURNING *
  `;

  const params = [
    slug, title, summary, shortDescription, description, mainImageUrl, mainImageLqip, cardBackgroundUrl,
    cardBackgroundVideoUrl, iconUrl, demoVideoUrl, skills, sectors, githubUrl, liveUrl, cohort, status,
    hasPartner, partnerName, partnerLogoUrl, backgroundColor
  ];
  
  const result = await pool.query(query, params);
  return result.rows[0];
};

// =====================================================
// UPDATE PROJECT
// =====================================================

const updateProject = async (slug, updates) => {
  const allowedFields = [
    'slug', 'title', 'summary', 'short_description', 'description', 'main_image_url', 'main_image_lqip',
    'card_background_url', 'card_background_video_url', 'icon_url', 'demo_video_url', 'skills', 'sectors', 'github_url', 'live_url',
    'cohort', 'status', 'has_partner', 'partner_name', 'partner_logo_url', 'background_color'
  ];
  
  const setClause = [];
  const params = [];
  let paramCount = 1;
  
  Object.keys(updates).forEach(key => {
    const dbKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    if (allowedFields.includes(dbKey)) {
      setClause.push(`${dbKey} = $${paramCount}`);
      params.push(updates[key]);
      paramCount++;
    }
  });
  
  if (setClause.length === 0) {
    throw new Error('No valid fields to update');
  }
  
  params.push(slug);
  const query = `
    UPDATE lookbook_projects 
    SET ${setClause.join(', ')}
    WHERE slug = $${paramCount}
    RETURNING *
  `;
  
  const result = await pool.query(query, params);
  return result.rows[0] || null;
};

// =====================================================
// DELETE PROJECT
// =====================================================

const deleteProject = async (slug) => {
  const query = 'DELETE FROM lookbook_projects WHERE slug = $1 RETURNING *';
  const result = await pool.query(query, [slug]);
  return result.rows[0] || null;
};

const deleteProjectById = async (id) => {
  const query = 'DELETE FROM lookbook_projects WHERE id = $1 RETURNING *';
  const result = await pool.query(query, [id]);
  return result.rows[0] || null;
};

// =====================================================
// ADD PARTICIPANT TO PROJECT
// =====================================================

const addParticipant = async (projectId, profileId, role = null, displayOrder = 0) => {
  const query = `
    INSERT INTO lookbook_project_participants (
      project_id, profile_id, role, display_order
    ) VALUES ($1, $2, $3, $4)
    ON CONFLICT (project_id, profile_id) DO UPDATE
    SET role = $3, display_order = $4
    RETURNING *
  `;
  
  const result = await pool.query(query, [projectId, profileId, role, displayOrder]);
  return result.rows[0];
};

// =====================================================
// REMOVE PARTICIPANT FROM PROJECT
// =====================================================

const removeParticipant = async (projectId, profileId) => {
  const query = `
    DELETE FROM lookbook_project_participants
    WHERE project_id = $1 AND profile_id = $2
    RETURNING *
  `;
  
  const result = await pool.query(query, [projectId, profileId]);
  return result.rows[0] || null;
};

// =====================================================
// GET PROJECTS BY PROFILE
// =====================================================

const getProjectsByProfile = async (profileId) => {
  const query = `
    SELECT 
      p.*,
      pp.role
    FROM lookbook_projects p
    JOIN lookbook_project_participants pp ON p.id = pp.project_id
    WHERE pp.profile_id = $1 AND p.status = 'active'
    ORDER BY p.created_at DESC
  `;
  
  const result = await pool.query(query, [profileId]);
  return result.rows;
};

// =====================================================
// GET ALL UNIQUE SKILLS (for filtering)
// =====================================================

const getAllSkills = async () => {
  const query = `
    SELECT DISTINCT unnest(skills) as name
    FROM lookbook_projects
    WHERE status = 'active'
      AND skills IS NOT NULL
      AND array_length(skills, 1) > 0
    ORDER BY name ASC
  `;
  
  const result = await pool.query(query);
  return result.rows.map(row => row.name);
};

// =====================================================
// GET ALL UNIQUE SECTORS (for filtering)
// =====================================================

const getAllSectors = async () => {
  const query = `
    SELECT DISTINCT unnest(sectors) as name
    FROM lookbook_projects
    WHERE status = 'active'
      AND sectors IS NOT NULL
      AND array_length(sectors, 1) > 0
    ORDER BY name ASC
  `;
  
  const result = await pool.query(query);
  return result.rows.map(row => row.name);
};

// =====================================================
// GET COHORTS (for filtering)
// =====================================================

const getAllCohorts = async () => {
  const query = `
    SELECT DISTINCT p.cohort
    FROM lookbook_projects p
    WHERE p.cohort IS NOT NULL AND p.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM lookbook_initiatives li
        WHERE li.cohort_value = p.cohort AND li.is_active = false
      )
    ORDER BY p.cohort DESC
  `;
  
  const result = await pool.query(query);
  return result.rows.map(row => row.cohort);
};

module.exports = {
  getAllProjects,
  getProjectBySlug,
  createProject,
  updateProject,
  deleteProject,
  deleteProjectById,
  addParticipant,
  removeParticipant,
  getProjectsByProfile,
  getAllSkills,
  getAllSectors,
  getAllCohorts
};

