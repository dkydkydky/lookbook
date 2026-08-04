// Profile queries for Lookbook - Compatible with segundo-db schema
// Follows the platform server query pattern

const { pool } = require('../db/dbConfig');

// Hide auto-generated placeholder profiles (Builder 261, builder-509, etc.) from the public site.
const PUBLIC_PROFILE_SQL = `
  NOT (
    p.slug ~ '^builder-[0-9]+$'
    OR COALESCE(u.first_name || ' ' || u.last_name, '') ~ '^Builder [0-9]+$'
  )
`;

function isStubProfile(profile) {
  if (!profile) return true;

  const slug = (profile.slug || '').trim();
  if (/^builder-\d+$/i.test(slug)) return true;

  const name = (profile.name || '').trim();
  if (/^Builder \d+$/i.test(name)) return true;

  return false;
}

function isProfileComplete(profile) {
  return !isStubProfile(profile);
}

// =====================================================
// GET ALL PROFILES
// =====================================================

const getAllProfiles = async (filters = {}) => {
  const { search, skills, openToWork, industries, limit = 50, offset = 0, completeOnly = false } = filters;
  
  // Build WHERE clause conditions
  const conditions = [];
  const params = [];
  let paramCount = 1;
  
  // Text search (name, title, skills)
  if (search) {
    conditions.push(`(
      COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(p.slug, '-', ' '))) ILIKE $${paramCount} OR 
      p.title ILIKE $${paramCount} OR 
      EXISTS (
        SELECT 1 FROM unnest(p.skills) AS skill 
        WHERE skill ILIKE $${paramCount}
      )
    )`);
    params.push(`%${search}%`);
    paramCount++;
  }
  
  // Skills filter (must have ALL specified skills)
  if (skills && skills.length > 0) {
    conditions.push(`p.skills @> $${paramCount}::text[]`);
    params.push(skills);
    paramCount++;
  }
  
  // Industry filter (must have ALL specified industries)
  if (industries && industries.length > 0) {
    conditions.push(`p.industry_expertise @> $${paramCount}::text[]`);
    params.push(industries);
    paramCount++;
  }
  
  // Open to work filter
  if (openToWork !== undefined) {
    conditions.push(`p.open_to_work = $${paramCount}`);
    params.push(openToWork);
    paramCount++;
  }

  if (completeOnly) {
    conditions.push(`(${PUBLIC_PROFILE_SQL})`);
  }
  
  const whereClause = conditions.length > 0 
    ? 'WHERE ' + conditions.join(' AND ')
    : '';
  
  // Use a CTE (Common Table Expression) for better performance
  // This avoids the expensive COUNT(*) OVER() window function
  const query = `
    WITH filtered_profiles AS (
      SELECT 
        p.id as profile_id,
        p.slug,
        p.title,
        p.bio,
        p.skills,
        p.industry_expertise,
        p.open_to_work,
        -- Effective "hired" status. p.hired is a tri-state override:
        --   NULL  -> auto-derive from employment_records (active full-time job)
        --   TRUE  -> always show the badge
        --   FALSE -> always hide the badge
        (CASE WHEN p.hired IS NULL THEN (emp.company_name IS NOT NULL) ELSE p.hired END) AS hired,
        -- Company shown on the badge: manual override wins, else the live employment record.
        COALESCE(NULLIF(btrim(p.hired_company), ''), emp.company_name) AS hired_company,
        -- Manually uploaded logo override (used by the badge when present).
        NULLIF(btrim(p.hired_company_logo_url), '') AS hired_company_logo_url,
        emp.role_title AS employment_role,
        p.highlights,
        p.photo_url,
        p.photo_lqip,
        p.linkedin_url,
        p.github_url,
        p.website_url,
        p.x_url,
        p.featured,
        COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(p.slug, '-', ' '))) as name,
        u.email as email,
        COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(p.slug, '-', ' '))) as sort_name,
        (
          SELECT COUNT(*)::int
          FROM lookbook_project_participants pp
          WHERE pp.profile_id = p.id
        ) as project_count
      FROM lookbook_profiles p
      LEFT JOIN users u ON p.user_id = u.user_id
      -- Most recent ACTIVE FULL-TIME employment record = "hired into a job".
      LEFT JOIN LATERAL (
        SELECT er.company_name, er.role_title
        FROM employment_records er
        WHERE er.user_id = p.user_id
          AND er.engagement_stage = 'active'
          AND er.employment_type = 'full_time'
          AND er.company_name IS NOT NULL
          AND btrim(er.company_name) <> ''
        ORDER BY er.start_date DESC NULLS LAST, er.created_at DESC NULLS LAST
        LIMIT 1
      ) emp ON true
      ${whereClause}
    ),
    profile_count AS (
      SELECT COUNT(*) as total FROM filtered_profiles
    )
    SELECT 
      fp.*,
      pc.total as total_count
    FROM filtered_profiles fp
    CROSS JOIN profile_count pc
    ORDER BY fp.sort_name ASC
    LIMIT $${paramCount} OFFSET $${paramCount + 1}
  `;
  
  params.push(limit, offset);
  
  const result = await pool.query(query, params);
  
  return {
    profiles: result.rows,
    total: result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0,
    limit,
    offset
  };
};

// =====================================================
// GET PROFILE BY SLUG
// =====================================================

const getProfileBySlug = async (slug) => {
  const query = `
    SELECT 
      p.*,
      COALESCE(u.first_name || ' ' || u.last_name, initcap(replace(p.slug, '-', ' '))) as name,
      u.email as email,
      (
        SELECT json_agg(
          json_build_object(
            'experience_id', e.id,
            'org', e.org,
            'role', e.role,
            'dateFrom', e.date_from,
            'dateTo', e.date_to,
            'summary', e.summary
          ) ORDER BY e.display_order
        )
        FROM lookbook_experience e
        WHERE e.profile_id = p.id
      ) as experience,
      (
        SELECT json_agg(
          json_build_object(
            'project_id', proj.id,
            'slug', proj.slug,
            'title', proj.title,
            'summary', proj.summary,
            'short_description', proj.short_description,
            'skills', proj.skills,
            'sectors', proj.sectors,
            'mainImageUrl', proj.main_image_url
          )
        )
        FROM lookbook_projects proj
        JOIN lookbook_project_participants pp ON proj.id = pp.project_id
        WHERE pp.profile_id = p.id
      ) as projects
    FROM lookbook_profiles p
    LEFT JOIN users u ON p.user_id = u.user_id
    WHERE p.slug = $1
  `;
  
  const result = await pool.query(query, [slug]);
  return result.rows[0] || null;
};

// =====================================================
// CREATE PROFILE
// =====================================================

const createProfile = async (profileData) => {
  const {
    userId,
    slug,
    title,
    bio,
    skills = [],
    industryExpertise = [],
    openToWork = false,
    hired = null,
    hiredCompany = null,
    hiredCompanyLogoUrl = null,
    highlights = [],
    photoUrl,
    photoLqip,
    linkedinUrl,
    githubUrl,
    websiteUrl,
    xUrl,
    featured = false
  } = profileData;
  
  const query = `
    INSERT INTO lookbook_profiles (
      user_id, slug, title, bio, skills, industry_expertise,
      open_to_work, hired, hired_company, hired_company_logo_url,
      highlights, photo_url, photo_lqip,
      linkedin_url, github_url, website_url, x_url, featured
    ) VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9, $10, $11::text[], $12, $13, $14, $15, $16, $17, $18)
    RETURNING *
  `;
  
  // Ensure arrays are properly formatted
  const params = [
    userId, 
    slug, 
    title, 
    bio, 
    Array.isArray(skills) ? skills : [], 
    Array.isArray(industryExpertise) ? industryExpertise : [],
    openToWork, 
    hired,
    hiredCompany,
    hiredCompanyLogoUrl,
    Array.isArray(highlights) ? highlights : [], 
    photoUrl, 
    photoLqip,
    linkedinUrl, 
    githubUrl, 
    websiteUrl, 
    xUrl, 
    featured
  ];
  
  const result = await pool.query(query, params);
  return result.rows[0];
};

// =====================================================
// UPDATE PROFILE
// =====================================================

const updateProfile = async (slug, updates) => {
  const allowedFields = [
    'slug', 'title', 'bio', 'skills', 'industry_expertise', 'open_to_work',
    'hired', 'hired_company', 'hired_company_logo_url',
    'highlights', 'photo_url', 'photo_lqip', 'linkedin_url',
    'github_url', 'website_url', 'x_url', 'featured'
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
    UPDATE lookbook_profiles 
    SET ${setClause.join(', ')}
    WHERE slug = $${paramCount}
    RETURNING *
  `;
  
  const result = await pool.query(query, params);
  return result.rows[0] || null;
};

// =====================================================
// DELETE PROFILE
// =====================================================

const deleteProfile = async (slug) => {
  const query = 'DELETE FROM lookbook_profiles WHERE slug = $1 RETURNING *';
  const result = await pool.query(query, [slug]);
  return result.rows[0] || null;
};

// =====================================================
// ADD EXPERIENCE
// =====================================================

const addExperience = async (profileId, experienceData) => {
  const { org, role, dateFrom, dateTo, summary, displayOrder = 0 } = experienceData;
  
  const query = `
    INSERT INTO lookbook_experience (
      profile_id, org, role, date_from, date_to, summary, display_order
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `;
  
  const result = await pool.query(query, [
    profileId, org, role, dateFrom, dateTo, summary, displayOrder
  ]);
  
  return result.rows[0];
};

// =====================================================
// GET ALL SKILLS (for filtering)
// =====================================================

const getAllSkills = async () => {
  const query = `
    SELECT name
    FROM lookbook_skills
    ORDER BY display_order ASC, name ASC
  `;
  
  const result = await pool.query(query);
  return result.rows.map(row => row.name);
};

// =====================================================
// GET ALL INDUSTRIES (for filtering)
// =====================================================

const getAllIndustries = async () => {
  const query = `
    SELECT name
    FROM lookbook_industries
    ORDER BY display_order ASC, name ASC
  `;
  
  const result = await pool.query(query);
  return result.rows.map(row => row.name);
};

module.exports = {
  getAllProfiles,
  getProfileBySlug,
  createProfile,
  updateProfile,
  deleteProfile,
  addExperience,
  getAllSkills,
  getAllIndustries,
  isProfileComplete,
  isStubProfile,
};


