// Profile routes for Lookbook API
// Following the platform server pattern

const express = require('express');
const router = express.Router();
const profileQueries = require('../queries/profileQueries');
const { pool } = require('../db/dbConfig');
const { processBase64Image, isBase64Image, uploadFileExists } = require('../utils/imageConverter');

// Simple in-memory cache for profiles (5 minute TTL)
const cache = {
  filters: null,
  filtersTimestamp: 0,
  TTL: 5 * 60 * 1000 // 5 minutes in milliseconds
};

const profileListCache = new Map();

function getProfileListCacheKey(filters) {
  return JSON.stringify({
    search: filters.search || '',
    skills: (filters.skills || []).slice().sort().join(','),
    industries: (filters.industries || []).slice().sort().join(','),
    openToWork: filters.openToWork,
    limit: filters.limit || 50,
    offset: filters.offset || 0,
    completeOnly: filters.completeOnly !== false,
  });
}

function getCachedProfileList(cacheKey) {
  const cached = profileListCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cache.TTL) {
    return cached.data;
  }
  return null;
}

function setCachedProfileList(cacheKey, data) {
  profileListCache.set(cacheKey, {
    data,
    timestamp: Date.now(),
  });
}

function invalidateProfileListCache() {
  profileListCache.clear();
}

// Helper to check if cache is valid
function isCacheValid(timestamp) {
  return Date.now() - timestamp < cache.TTL;
}

async function resolveProfilePhotoUrl(rawPhotoUrl, slug) {
  if (!rawPhotoUrl) return null;

  if (isBase64Image(rawPhotoUrl)) {
    const result = await processBase64Image(rawPhotoUrl, 'profiles', `${slug}-`, { maxWidth: 800, quality: 85 });
    if (!uploadFileExists(result.url)) {
      throw new Error(`Profile photo could not be saved for ${slug}`);
    }
    return result.url;
  }

  if (typeof rawPhotoUrl === 'string' && rawPhotoUrl.startsWith('/uploads/') && !uploadFileExists(rawPhotoUrl)) {
    throw new Error(`Profile photo file is missing on disk: ${rawPhotoUrl}`);
  }

  return rawPhotoUrl;
}

// =====================================================
// GET /api/profiles
// Get all profiles with optional filtering
// =====================================================

router.get('/', async (req, res) => {
  try {
    const { search, skills, openToWork, industries, limit, offset, page, includeIncomplete } = req.query;
    const showIncomplete = includeIncomplete === 'true';
    const hasCacheBuster = req.query._t; // Cache-busting parameter

    // Parse filters
    const filters = {
      search,
      skills: skills ? (Array.isArray(skills) ? skills : skills.split(',')) : undefined,
      industries: industries ? (Array.isArray(industries) ? industries : industries.split(',')) : undefined,
      openToWork: openToWork === 'true' ? true : openToWork === 'false' ? false : undefined,
      limit: parseInt(limit) || 50,
      offset: page ? (parseInt(page) - 1) * (parseInt(limit) || 50) : parseInt(offset) || 0,
      completeOnly: !showIncomplete,
    };

    const cacheKey = getProfileListCacheKey(filters);
    if (!hasCacheBuster) {
      const cachedResponse = getCachedProfileList(cacheKey);
      if (cachedResponse) {
        res.set('Cache-Control', 'no-cache');
        return res.json(cachedResponse);
      }
    }
    
    const result = await profileQueries.getAllProfiles(filters);
    
    const response = {
      success: true,
      data: result.profiles,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        page: Math.floor(result.offset / result.limit) + 1,
        totalPages: Math.ceil(result.total / result.limit)
      }
    };
    
    if (!hasCacheBuster) {
      setCachedProfileList(cacheKey, response);
    }
    res.set('Cache-Control', 'no-cache');
    res.json(response);
  } catch (error) {
    console.error('Error fetching profiles:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch profiles',
      message: error.message 
    });
  }
});

// =====================================================
// GET /api/profiles/filters
// Get available filter options (skills, industries)
// =====================================================

router.get('/filters', async (req, res) => {
  try {
    // Check cache first
    if (cache.filters && isCacheValid(cache.filtersTimestamp)) {
      res.set('Cache-Control', 'no-cache');
      return res.json(cache.filters);
    }
    
    const [skills, industries] = await Promise.all([
      profileQueries.getAllSkills(),
      profileQueries.getAllIndustries()
    ]);
    
    const response = {
      success: true,
      data: {
        skills,
        industries
      }
    };
    
    // Cache the filters
    cache.filters = response;
    cache.filtersTimestamp = Date.now();
    
    // Set cache headers
    res.set('Cache-Control', 'no-cache');
    
    res.json(response);
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
// GET /api/profiles/available-users
// Fetch users from the users table who don't have lookbook profiles yet
// Supports filtering by cohort, search, role
// MUST be defined before /:slug to avoid Express matching "available-users" as a slug
// =====================================================

router.get('/available-users', async (req, res) => {
  try {
    const { search, cohort, role, limit = 100, offset = 0 } = req.query;

    const conditions = ['p.id IS NULL'];
    const params = [];
    let paramCount = 1;

    if (search) {
      conditions.push(`(
        u.first_name ILIKE $${paramCount} OR
        u.last_name ILIKE $${paramCount} OR
        u.email ILIKE $${paramCount} OR
        CONCAT(u.first_name, ' ', u.last_name) ILIKE $${paramCount}
      )`);
      params.push(`%${search}%`);
      paramCount++;
    }

    if (cohort) {
      conditions.push(`u.cohort = $${paramCount}`);
      params.push(cohort);
      paramCount++;
    }

    if (role) {
      conditions.push(`u.role = $${paramCount}`);
      params.push(role);
      paramCount++;
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const query = `
      SELECT
        u.user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.role,
        u.cohort,
        CONCAT(u.first_name, ' ', u.last_name) AS full_name
      FROM users u
      LEFT JOIN lookbook_profiles p ON u.user_id = p.user_id
      ${whereClause}
      ORDER BY u.last_name, u.first_name
      LIMIT $${paramCount} OFFSET $${paramCount + 1}
    `;
    params.push(parseInt(limit), parseInt(offset));

    const countQuery = `
      SELECT COUNT(*) as total
      FROM users u
      LEFT JOIN lookbook_profiles p ON u.user_id = p.user_id
      ${whereClause}
    `;

    const [usersResult, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, params.slice(0, -2))
    ]);

    // Fetch distinct cohorts for the filter dropdown
    const cohortsResult = await pool.query(`
      SELECT DISTINCT u.cohort
      FROM users u
      LEFT JOIN lookbook_profiles p ON u.user_id = p.user_id
      WHERE p.id IS NULL AND u.cohort IS NOT NULL AND u.cohort != ''
      ORDER BY u.cohort
    `);

    res.json({
      success: true,
      data: usersResult.rows,
      total: parseInt(countResult.rows[0].total),
      cohorts: cohortsResult.rows.map(r => r.cohort)
    });
  } catch (error) {
    console.error('Error fetching available users:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available users',
      message: error.message
    });
  }
});

// =====================================================
// POST /api/profiles/bulk
// Create lookbook profiles for multiple existing users
// Expects { userIds: number[] }
// MUST be defined before /:slug
// =====================================================

router.post('/bulk', async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'userIds must be a non-empty array'
      });
    }

    const results = { success: [], failed: [] };

    for (const userId of userIds) {
      try {
        const userResult = await pool.query(
          'SELECT user_id, first_name, last_name, email FROM users WHERE user_id = $1',
          [userId]
        );
        if (userResult.rows.length === 0) {
          results.failed.push({ userId, error: 'User not found' });
          continue;
        }
        const user = userResult.rows[0];

        const existingProfile = await pool.query(
          'SELECT id FROM lookbook_profiles WHERE user_id = $1',
          [userId]
        );
        if (existingProfile.rows.length > 0) {
          results.failed.push({
            userId,
            name: `${user.first_name} ${user.last_name}`,
            error: 'Already has a lookbook profile'
          });
          continue;
        }

        let slug = `${user.first_name}-${user.last_name}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '');

        // Handle slug collisions
        let finalSlug = slug;
        let suffix = 2;
        while (true) {
          const slugCheck = await pool.query(
            'SELECT id FROM lookbook_profiles WHERE slug = $1',
            [finalSlug]
          );
          if (slugCheck.rows.length === 0) break;
          finalSlug = `${slug}-${suffix}`;
          suffix++;
        }

        const newProfile = await profileQueries.createProfile({
          userId,
          slug: finalSlug,
          title: null,
          bio: null,
          skills: [],
          industryExpertise: [],
          openToWork: false,
          highlights: [],
          photoUrl: null,
          photoLqip: null,
          linkedinUrl: null,
          githubUrl: null,
          websiteUrl: null,
          xUrl: null,
          featured: false
        });

        results.success.push({
          userId,
          name: `${user.first_name} ${user.last_name}`,
          slug: finalSlug,
          profileId: newProfile.id
        });
      } catch (err) {
        results.failed.push({
          userId,
          error: err.message
        });
      }
    }

    // Invalidate cache
    invalidateProfileListCache();
    cache.filters = null;

    res.status(201).json({
      success: true,
      data: results,
      message: `Created ${results.success.length} profiles, ${results.failed.length} failed`
    });
  } catch (error) {
    console.error('Error bulk creating profiles:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to bulk create profiles',
      message: error.message
    });
  }
});

// =====================================================
// GET /api/profiles/:slug
// Get single profile by slug
// =====================================================

router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const showIncomplete = req.query.includeIncomplete === 'true';
    const profile = await profileQueries.getProfileBySlug(slug);
    
    if (!profile || (!showIncomplete && !profileQueries.isProfileComplete(profile))) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    // Set cache headers for individual profiles (longer cache)
    res.set('Cache-Control', 'no-cache');
    
    res.json({
      success: true,
      data: profile
    });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch profile',
      message: error.message 
    });
  }
});

// =====================================================
// POST /api/profiles
// Create new profile
// TODO: Add authentication middleware
// =====================================================

router.post('/', async (req, res) => {
  try {
    const profileData = req.body;
    
    // Basic validation
    if (!profileData.slug) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: slug'
      });
    }

    // Check if slug already exists before proceeding
    const normalizedSlug = profileData.slug.trim().toLowerCase();
    const existingProfileCheck = await pool.query(
      'SELECT id, slug FROM lookbook_profiles WHERE slug = $1 LIMIT 1',
      [normalizedSlug]
    );
    if (existingProfileCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: `A profile with the slug "${normalizedSlug}" already exists. Please use a different slug.`
      });
    }
    
    // If no userId provided, try to find or create a user
    let userId = profileData.userId;
    let nameUpdateFailed = false; // Track if name update failed
    if (!userId) {
      // Extract name from profile data or use slug as fallback
      const nameParts = profileData.name ? profileData.name.split(' ') : [profileData.slug, ''];
      const firstName = nameParts[0] || profileData.slug;
      const lastName = nameParts.slice(1).join(' ') || '';
      
      // Generate email
      const email = profileData.email || `${profileData.slug}@pursuit.org`;
      
      // First, try to find existing user by email
      const findUserQuery = 'SELECT user_id FROM users WHERE email = $1 LIMIT 1';
      const existingUser = await pool.query(findUserQuery, [email]);
      
      if (existingUser.rows.length > 0) {
        userId = existingUser.rows[0].user_id;
        console.log('Found existing user with ID:', userId);
        
        // Check if this user already has a profile
        const existingProfileCheck = await pool.query(
          'SELECT id FROM lookbook_profiles WHERE user_id = $1 LIMIT 1',
          [userId]
        );
        if (existingProfileCheck.rows.length > 0) {
          console.warn('User already has a profile, will need to create new user or use different user');
          userId = null; // Reset to trigger user creation or fallback
        }
      }
      
      if (!userId) {
        // Also try to find by name (first_name + last_name) as fallback
        const findByNameQuery = `
          SELECT u.user_id 
          FROM users u 
          LEFT JOIN lookbook_profiles p ON u.user_id = p.user_id 
          WHERE u.first_name = $1 AND u.last_name = $2 AND p.id IS NULL 
          LIMIT 1
        `;
        const userByName = await pool.query(findByNameQuery, [firstName, lastName]);
        
        if (userByName.rows.length > 0) {
          userId = userByName.rows[0].user_id;
          console.log('Found existing user by name with ID:', userId, '(without existing profile)');
        } else {
          // Try to create a new user, but handle permission errors gracefully
          try {
            const userQuery = `
              INSERT INTO users (first_name, last_name, email, password_hash, role, cohort)
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING user_id
            `;
            const userResult = await pool.query(userQuery, [
              firstName,
              lastName,
              email,
              'placeholder_hash', // Placeholder password hash
              'builder',
              '2024'
            ]);
            userId = userResult.rows[0].user_id;
            console.log('Created new user with ID:', userId);
          } catch (userError) {
            console.error('Error creating user:', userError);
            console.error('Error code:', userError.code);
            console.error('Error message:', userError.message);
            
            // If it's a permission error, use an existing user as fallback
            if (userError.code === '42501' || userError.message.includes('permission denied')) {
              console.warn('Cannot create user due to permissions, using fallback user');
              
              // Try to find any user with matching first name that doesn't have a profile
              const findSimilarQuery = `
                SELECT u.user_id 
                FROM users u 
                LEFT JOIN lookbook_profiles p ON u.user_id = p.user_id 
                WHERE u.first_name = $1 AND p.id IS NULL 
                LIMIT 1
              `;
              const similarUser = await pool.query(findSimilarQuery, [firstName]);
              
              if (similarUser.rows.length > 0) {
                userId = similarUser.rows[0].user_id;
                console.log('Using similar user with ID:', userId, '(without existing profile)');
                
                // Try to update the user's name to match the profile
                try {
                  const updateResult = await pool.query(
                    'UPDATE users SET first_name = $1, last_name = $2 WHERE user_id = $3 RETURNING first_name, last_name',
                    [firstName, lastName, userId]
                  );
                  console.log('✅ Updated similar user name to:', updateResult.rows[0].first_name, updateResult.rows[0].last_name);
                } catch (updateError) {
                  console.error('❌ Could not update similar user name:', updateError.code, updateError.message);
                  console.error('❌ Profile will be created but name may not match');
                  nameUpdateFailed = true; // Flag that name update failed
                }
              } else {
                // As a last resort, find a user that doesn't already have a profile
                // This allows profile creation to proceed even without user creation permissions
                const fallbackUserQuery = `
                  SELECT u.user_id 
                  FROM users u 
                  LEFT JOIN lookbook_profiles p ON u.user_id = p.user_id 
                  WHERE p.id IS NULL 
                  ORDER BY u.user_id 
                  LIMIT 1
                `;
                const fallbackUser = await pool.query(fallbackUserQuery);
                
                if (fallbackUser.rows.length > 0) {
                  userId = fallbackUser.rows[0].user_id;
                  console.log('Using fallback user with ID:', userId, '(user without existing profile)');
                  
                  // Update the fallback user's name to match the profile name
                  try {
                    const updateResult = await pool.query(
                      'UPDATE users SET first_name = $1, last_name = $2 WHERE user_id = $3 RETURNING first_name, last_name',
                      [firstName, lastName, userId]
                    );
                    console.log('✅ Updated fallback user name to:', updateResult.rows[0].first_name, updateResult.rows[0].last_name);
                  } catch (updateError) {
                    console.error('❌ CRITICAL: Could not update user name:', updateError.code, updateError.message);
                    console.error('❌ Profile will be created with user ID', userId, 'but name will remain as original user name');
                    console.error('❌ This is due to missing UPDATE permission on users table');
                    nameUpdateFailed = true; // Flag that name update failed
                    // Continue anyway - profile will be created with existing user name
                  }
                } else {
                  return res.status(500).json({
                    success: false,
                    error: 'No users available',
                    message: 'Cannot create profile: No users exist in the database and user creation is not permitted. Please contact your database administrator.'
                  });
                }
              }
            } else if (userError.code === '23505') {
              // For duplicate email errors, try to find the user
              const findUserQuery = 'SELECT user_id FROM users WHERE email = $1 LIMIT 1';
              const foundUser = await pool.query(findUserQuery, [email]);
              if (foundUser.rows.length > 0) {
                userId = foundUser.rows[0].user_id;
                console.log('User already exists, using existing user ID:', userId);
              } else {
                throw new Error(`Failed to create user: ${userError.message}`);
              }
            } else {
              throw new Error(`Failed to create user: ${userError.message}`);
            }
          }
        }
      }
    }
    
    const slug = profileData.slug.trim().toLowerCase();
    const rawPhotoUrl = profileData.photoUrl || profileData.photo_url || null;
    const processedPhotoUrl = await resolveProfilePhotoUrl(rawPhotoUrl, slug);

    const rawLogoUrl = profileData.hiredCompanyLogoUrl || profileData.hired_company_logo_url || null;
    const processedLogoUrl = isBase64Image(rawLogoUrl)
      ? (await processBase64Image(rawLogoUrl, 'profiles', `${slug}-logo-`, { maxWidth: 400, quality: 90 })).url
      : rawLogoUrl;

    // Normalize field names: convert snake_case to camelCase
    // Handle both formats for compatibility
    // Ensure arrays are always arrays (not null/undefined)
    const normalizedData = {
      userId,
      slug: profileData.slug.trim().toLowerCase(), // Ensure slug is trimmed and lowercase
      title: profileData.title || null,
      bio: profileData.bio || null,
      skills: Array.isArray(profileData.skills) ? profileData.skills : [],
      industryExpertise: Array.isArray(profileData.industryExpertise) ? profileData.industryExpertise : (Array.isArray(profileData.industry_expertise) ? profileData.industry_expertise : []),
      openToWork: profileData.openToWork !== undefined ? profileData.openToWork : (profileData.open_to_work !== undefined ? profileData.open_to_work : false),
      hired: profileData.hired !== undefined ? profileData.hired : null,
      hiredCompany: profileData.hiredCompany || profileData.hired_company || null,
      hiredCompanyLogoUrl: processedLogoUrl,
      highlights: Array.isArray(profileData.highlights) ? profileData.highlights : [],
      photoUrl: processedPhotoUrl,
      photoLqip: profileData.photoLqip || profileData.photo_lqip || null,
      linkedinUrl: profileData.linkedinUrl || profileData.linkedin_url || null,
      githubUrl: profileData.githubUrl || profileData.github_url || null,
      websiteUrl: profileData.websiteUrl || profileData.website_url || null,
      xUrl: profileData.xUrl || profileData.x_url || null,
      featured: profileData.featured !== undefined ? profileData.featured : false
    };
    
    // Log the data being inserted for debugging
    console.log('Creating profile with data:', {
      userId: normalizedData.userId,
      slug: normalizedData.slug,
      skills: normalizedData.skills,
      industryExpertise: normalizedData.industryExpertise,
      highlights: normalizedData.highlights
    });
    
    const newProfile = await profileQueries.createProfile(normalizedData);

    // Save experience entries if provided
    const experience = profileData.experience;
    if (experience && Array.isArray(experience) && experience.length > 0) {
      for (let i = 0; i < experience.length; i++) {
        const exp = experience[i];
        await pool.query(`
          INSERT INTO lookbook_experience (profile_id, org, role, date_from, date_to, display_order)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          newProfile.id,
          exp.org || '',
          exp.role || '',
          exp.dateFrom || exp.date_from || '',
          exp.dateTo || exp.date_to || '',
          i
        ]);
      }
    }

    // Invalidate cache
    invalidateProfileListCache();
    cache.filters = null;
    
    const response = {
      success: true,
      data: newProfile,
      message: 'Profile created successfully'
    };
    
    // Add warning if name update failed
    if (nameUpdateFailed) {
      response.warning = 'Profile created, but the name could not be updated due to database permissions. The profile may show a different name than entered. Please contact your database administrator to grant UPDATE permission on the users table.';
    }
    
    res.status(201).json(response);
  } catch (error) {
    console.error('Error creating profile:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      detail: error.detail,
      constraint: error.constraint,
      table: error.table,
      column: error.column
    });
    
    // Handle duplicate constraint errors
    if (error.code === '23505') {
      // Check if it's a duplicate email or slug
      const errorMessage = error.message || '';
      if (errorMessage.includes('email') || errorMessage.includes('users_email_key')) {
        return res.status(409).json({
          success: false,
          error: 'A user with this email already exists. Please use a different slug or provide a unique email.'
        });
      } else if (errorMessage.includes('slug') || errorMessage.includes('lookbook_profiles_slug_key')) {
        // Try to get the slug from the request to make the error more specific
        const slug = req.body?.slug || 'this slug';
        return res.status(409).json({
          success: false,
          error: `A profile with the slug "${slug}" already exists. Please use a different slug.`
        });
      } else if (errorMessage.includes('unique_user_lookbook_profile') || errorMessage.includes('unique_user_profile')) {
        return res.status(409).json({
          success: false,
          error: 'This user already has a profile'
        });
      }
      // Generic duplicate error
      return res.status(409).json({
        success: false,
        error: 'A record with this information already exists'
      });
    }
    
    // Handle foreign key constraint errors
    if (error.code === '23503') {
      return res.status(400).json({
        success: false,
        error: 'Invalid user reference. Please ensure the user exists.'
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
    
    // Include more details in development
    const errorResponse = {
      success: false,
      error: 'Failed to create profile',
      message: error.message
    };
    
    // Add detailed error info in development mode
    if (process.env.NODE_ENV === 'development') {
      errorResponse.details = {
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        table: error.table,
        column: error.column,
        stack: error.stack
      };
    }
    
    res.status(500).json(errorResponse);
  }
});

// =====================================================
// PUT /api/profiles/:slug
// Update profile
// TODO: Add authentication middleware
// =====================================================

router.put('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const updates = req.body;
    let nameUpdateWarning = null;  // Track if name update failed due to permissions
    
    console.log('📝 Profile update request for slug:', slug);
    console.log('📝 Update data received:', Object.keys(updates));
    console.log('📝 Name in updates:', updates.name);
    
    // Separate experience from other updates
    const { experience, ...profileUpdates } = updates;
    
    let photoUpdateWarning = null;
    const rawPhotoUpdate = profileUpdates.photo_url || profileUpdates.photoUrl;
    if (rawPhotoUpdate !== undefined) {
      if (isBase64Image(rawPhotoUpdate)) {
        profileUpdates.photo_url = await resolveProfilePhotoUrl(rawPhotoUpdate, slug);
      } else if (
        typeof rawPhotoUpdate === 'string' &&
        rawPhotoUpdate.startsWith('/uploads/') &&
        !uploadFileExists(rawPhotoUpdate)
      ) {
        const existingProfile = await profileQueries.getProfileBySlug(slug);
        const existingPhoto = existingProfile?.photo_url || existingProfile?.photoUrl;
        if (existingPhoto === rawPhotoUpdate) {
          // Allow saving other fields, but tell the client the photo still needs a re-upload.
          delete profileUpdates.photo_url;
          delete profileUpdates.photoUrl;
          photoUpdateWarning =
            'Your other changes were saved, but the photo file is missing. Upload the photo again, then save.';
        } else {
          throw new Error(`Profile photo file is missing on disk: ${rawPhotoUpdate}`);
        }
      } else {
        profileUpdates.photo_url = rawPhotoUpdate;
      }
      delete profileUpdates.photoUrl;
    }

    // Process the hiring company logo if a new base64 image was provided
    const rawLogoUpdate = profileUpdates.hired_company_logo_url || profileUpdates.hiredCompanyLogoUrl;
    if (rawLogoUpdate !== undefined) {
      if (isBase64Image(rawLogoUpdate)) {
        const logoResult = await processBase64Image(rawLogoUpdate, 'profiles', `${slug}-logo-`, { maxWidth: 400, quality: 90 });
        profileUpdates.hired_company_logo_url = logoResult.url;
      } else {
        profileUpdates.hired_company_logo_url = rawLogoUpdate;
      }
      delete profileUpdates.hiredCompanyLogoUrl;
    }

    // Normalize field names: convert snake_case to camelCase for updateProfile
    // The updateProfile function expects camelCase, but frontend sends snake_case
    const normalizedUpdates = {};
    const fieldMapping = {
      'industry_expertise': 'industryExpertise',
      'open_to_work': 'openToWork',
      'photo_url': 'photoUrl',
      'photo_lqip': 'photoLqip',
      'linkedin_url': 'linkedinUrl',
      'github_url': 'githubUrl',
      'website_url': 'websiteUrl',
      'x_url': 'xUrl'
    };
    
    Object.keys(profileUpdates).forEach(key => {
      // If it's a snake_case field that needs conversion, convert it
      if (fieldMapping[key]) {
        normalizedUpdates[fieldMapping[key]] = profileUpdates[key];
      } else {
        // Keep camelCase fields as-is, or convert to camelCase if needed
        const camelKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
        normalizedUpdates[camelKey] = profileUpdates[key];
      }
    });
    
    // Update the profile
    const updatedProfile = await profileQueries.updateProfile(slug, normalizedUpdates);
    
    if (!updatedProfile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    // If name is provided in updates, also update the user's name in the users table
    // — but only if it actually changed (form always sends name even when unedited)
    if (updates.name) {
      try {
        const nameParts = updates.name.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        // Resolve user_id
        let userId = updatedProfile.user_id;
        if (!userId) {
          const profileWithUser = await profileQueries.getProfileBySlug(slug);
          userId = profileWithUser?.user_id;
        }
        if (!userId) {
          const directQuery = await pool.query(
            'SELECT user_id FROM lookbook_profiles WHERE slug = $1', [slug]
          );
          if (directQuery.rows.length > 0) userId = directQuery.rows[0].user_id;
        }

        if (userId) {
          // Only write if the name actually changed.
          // Use COALESCE to get the same display name the API returns, so the
          // comparison is apples-to-apples and doesn't false-positive when
          // first_name / last_name are NULL (JS `${null}` → "null").
          const current = await pool.query(
            `SELECT COALESCE(
               NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ''),
               NULL
             ) AS display_name
             FROM users WHERE user_id = $1`,
            [userId]
          );
          const currentName = current.rows[0]?.display_name ?? null;
          const desiredName = updates.name.trim();
          const slugDisplayName = slug
            .split('-')
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
          const effectiveCurrentName = (currentName && currentName.trim()) || slugDisplayName;

          if (desiredName !== effectiveCurrentName) {
            try {
              await pool.query(
                'UPDATE users SET first_name = $1, last_name = $2 WHERE user_id = $3',
                [firstName, lastName, userId]
              );
              console.log('✅ Updated user name to:', updates.name);
            } catch (updateError) {
              if (updateError.code === '42501' || updateError.message.includes('permission denied')) {
                nameUpdateWarning =
                  'Profile saved. The linked user account name could not be updated (database permissions). The lookbook display name is unchanged.';
              } else {
                console.error('⚠️ Name update failed:', updateError.message);
              }
            }
          } else {
            console.log('ℹ️ Name unchanged, skipping users table update');
          }
        } else {
          console.warn('⚠️ Could not find user_id for profile:', slug);
        }
      } catch (nameUpdateError) {
        console.error('❌ Error in name update logic:', nameUpdateError.message);
      }
    }
    
    // If experience data is provided, update it (this MUST run regardless of name update result)
    if (experience && Array.isArray(experience)) {
      // First, delete all existing experience for this profile
      await pool.query('DELETE FROM lookbook_experience WHERE profile_id = $1', [updatedProfile.id]);
      
      // Then insert all experience entries
      for (let i = 0; i < experience.length; i++) {
        const exp = experience[i];
        await pool.query(`
          INSERT INTO lookbook_experience (profile_id, org, role, date_from, date_to, display_order)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          updatedProfile.id,
          exp.org || '',
          exp.role || '',
          exp.dateFrom || exp.date_from || '',
          exp.dateTo || exp.date_to || '',
          i
        ]);
      }
    }
    
    // Invalidate cache
    invalidateProfileListCache();
    
    // Build response with optional warning
    const response = {
      success: true,
      data: updatedProfile,
      message: 'Profile updated successfully'
    };
    
    const warnings = [nameUpdateWarning, photoUpdateWarning].filter(Boolean);
    if (warnings.length === 1) {
      response.warning = warnings[0];
    } else if (warnings.length > 1) {
      response.warning = warnings.join(' ');
    }
    
    res.json(response);
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update profile',
      message: error.message 
    });
  }
});

// =====================================================
// DELETE /api/profiles/:slug
// Delete profile
// TODO: Add authentication middleware
// =====================================================

router.delete('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const deletedProfile = await profileQueries.deleteProfile(slug);
    
    if (!deletedProfile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    // Invalidate cache
    invalidateProfileListCache();
    cache.filters = null;
    
    res.json({
      success: true,
      message: 'Profile deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting profile:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete profile',
      message: error.message 
    });
  }
});

// =====================================================
// POST /api/profiles/:slug/experience
// Add experience to profile
// TODO: Add authentication middleware
// =====================================================

router.post('/:slug/experience', async (req, res) => {
  try {
    const { slug } = req.params;
    
    // First get the profile to get the ID
    const profile = await profileQueries.getProfileBySlug(slug);
    if (!profile) {
      return res.status(404).json({ 
        success: false,
        error: 'Profile not found' 
      });
    }
    
    const experienceData = req.body;
    const newExperience = await profileQueries.addExperience(profile.id, experienceData);
    
    res.status(201).json({
      success: true,
      data: newExperience,
      message: 'Experience added successfully'
    });
  } catch (error) {
    console.error('Error adding experience:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to add experience',
      message: error.message 
    });
  }
});

module.exports = router;
