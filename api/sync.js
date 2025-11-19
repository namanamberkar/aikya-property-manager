import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabase = createClient(
  'https://fiqlikvsoqqlcbbtsmwl.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpcWxpa3Zzb3FxbGNiYnRzbXdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI0OTY5NTgsImV4cCI6MjA3ODA3Mjk1OH0.ESMTiXRhIYnsMJ34XYESHrTyt-U1YtIENXWCDCwWleM'
);

// Google Sheets authentication
async function authenticateGoogleSheets() {
  try {
    // Handle private key formatting - multiple scenarios
    let privateKey = process.env.GOOGLE_PRIVATE_KEY;
    
    if (!privateKey) {
      throw new Error('GOOGLE_PRIVATE_KEY environment variable is missing');
    }
    
    // Clean up the private key - remove quotes and handle newlines
    privateKey = privateKey
      .replace(/^"|"$/g, '') // Remove surrounding quotes if present
      .replace(/\\n/g, '\n') // Convert \n to actual newlines
      .trim();

    // Ensure the private key has proper BEGIN/END format
    if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
      privateKey = `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        "type": "service_account",
        "project_id": process.env.GOOGLE_PROJECT_ID,
        "private_key_id": process.env.GOOGLE_PRIVATE_KEY_ID,
        "private_key": privateKey,
        "client_email": process.env.GOOGLE_CLIENT_EMAIL,
        "client_id": process.env.GOOGLE_CLIENT_ID
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    return sheets;
  } catch (error) {
    console.error('Google Sheets authentication failed:', error);
    throw new Error(`Authentication failed: ${error.message}`);
  }
}

function extractSpreadsheetId(url) {
  if (!url) return null;
  
  // Handle different URL formats
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  
  // If it's already just an ID (no URL structure)
  if (/^[a-zA-Z0-9-_]+$/.test(url)) return url;
  
  return null;
}

// Validate environment variables
function validateEnvironment() {
  const required = [
    'GOOGLE_PRIVATE_KEY',
    'GOOGLE_CLIENT_EMAIL',
    'GOOGLE_PROJECT_ID'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

async function pushToSheets(spreadsheetId) {
  try {
    validateEnvironment();
    const sheets = await authenticateGoogleSheets();
    
    // Get data from Supabase
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .order('check_in_date', { ascending: true });

    if (error) throw new Error(`Supabase query failed: ${error.message}`);

    console.log(`Found ${bookings?.length || 0} bookings to sync`);

    // Prepare headers
    const headers = [
      'id',
      'guest_name', 
      'phone_number',
      'check_in_date',
      'check_out_date',
      'property_id',
      'property_name',
      'source',
      'amount_paid',
      'sync_status',
      'booked_at'
    ];

    // Prepare data rows
    const values = bookings?.map(booking => [
      booking.id,
      booking.guest_name || '',
      booking.phone_number || '',
      booking.check_in_date || '',
      booking.check_out_date || '',
      booking.property_id || '',
      booking.property_name || '',
      booking.source || 'Direct',
      booking.amount_paid || 0,
      booking.sync_status || 'Not Configured',
      booking.booked_at || new Date().toISOString()
    ]) || [];

    // Clear existing data
    await sheets.spreadsheets.values.clear({
      spreadsheetId: spreadsheetId,
      range: 'Bookings!A:K',
    });

    // Write headers and data
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: 'Bookings!A1',
      valueInputOption: 'RAW',
      resource: {
        values: [headers, ...values]
      }
    });

    return {
      success: true,
      message: `Successfully pushed ${values.length} bookings to Google Sheets`,
      count: values.length
    };
  } catch (error) {
    console.error('Push to Sheets error:', error);
    throw new Error(`Push to Sheets failed: ${error.message}`);
  }
}

async function pullFromSheets(spreadsheetId) {
  try {
    validateEnvironment();
    const sheets = await authenticateGoogleSheets();
    
    // Get data from Google Sheets
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'Bookings!A2:K', // Skip header row
    });

    const rows = response.data.values || [];
    
    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    // Process each row and update Supabase
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Skip empty rows or rows without essential data
        if (!row || row.length === 0 || !row[0] || !row[1]) {
          console.log(`Skipping row ${i + 2}: missing essential data`);
          continue;
        }

        const bookingData = {
          id: String(row[0]).trim(), // Ensure string type
          guest_name: String(row[1] || '').trim(),
          phone_number: String(row[2] || '').trim(),
          check_in_date: row[3] || null,
          check_out_date: row[4] || null,
          property_id: String(row[5] || '').trim(),
          property_name: String(row[6] || '').trim(),
          source: String(row[7] || 'Direct').trim(),
          amount_paid: parseFloat(row[8]) || 0,
          sync_status: String(row[9] || 'Synced').trim(),
          booked_at: row[10] || new Date().toISOString()
        };

        // Validate required fields
        if (!bookingData.guest_name) {
          throw new Error('Guest name is required');
        }

        // Upsert into Supabase
        const { error } = await supabase
          .from('bookings')
          .upsert(bookingData, { onConflict: 'id' });

        if (error) {
          throw new Error(`Database error: ${error.message}`);
        } else {
          successCount++;
        }
      } catch (rowError) {
        console.error(`Error processing row ${i + 2}:`, rowError);
        errorCount++;
        errors.push(`Row ${i + 2}: ${rowError.message}`);
      }
    }

    return {
      success: true,
      message: `Pulled ${successCount} bookings from Google Sheets. ${errorCount} errors.`,
      successCount,
      errorCount,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (error) {
    console.error('Pull from Sheets error:', error);
    throw new Error(`Pull from Sheets failed: ${error.message}`);
  }
}

async function testConnections(spreadsheetId) {
  try {
    // Test Supabase connection
    const { data: supabaseTest, error: supabaseError } = await supabase
      .from('bookings')
      .select('count')
      .limit(1);

    if (supabaseError) throw new Error(`Supabase: ${supabaseError.message}`);

    // Test Google Sheets connection
    validateEnvironment();
    const sheets = await authenticateGoogleSheets();
    
    if (spreadsheetId) {
      await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
    }

    return {
      success: true,
      message: 'Both Supabase and Google Sheets connections are working',
      supabase: 'Connected',
      googleSheets: 'Connected'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      supabase: 'Error',
      googleSheets: 'Error'
    };
  }
}

async function fullSync(spreadsheetId) {
  try {
    const pushResult = await pushToSheets(spreadsheetId);
    
    return {
      success: true,
      message: `Full sync completed: ${pushResult.message}`,
      count: pushResult.count
    };
  } catch (error) {
    throw new Error(`Full sync failed: ${error.message}`);
  }
}

// MAIN API HANDLER
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Simple health check
  if (req.method === 'GET') {
    return res.status(200).json({ 
      status: 'OK', 
      service: 'Property Manager Sync API',
      timestamp: new Date().toISOString()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, spreadsheetId, spreadsheetUrl } = req.body;

    if (!action) {
      return res.status(400).json({ 
        success: false,
        error: 'Action is required. Valid actions: test, sheets-to-supabase, supabase-to-sheets, full-sync' 
      });
    }

    const finalSpreadsheetId = spreadsheetId || extractSpreadsheetId(spreadsheetUrl);

    if (!finalSpreadsheetId && action !== 'test') {
      return res.status(400).json({ 
        success: false,
        error: 'Valid Spreadsheet ID or URL is required' 
      });
    }

    let result;

    switch (action) {
      case 'test':
        result = await testConnections(finalSpreadsheetId);
        break;
      case 'sheets-to-supabase':
      case 'pull':
        result = await pullFromSheets(finalSpreadsheetId);
        break;
      case 'supabase-to-sheets':
      case 'push':
        result = await pushToSheets(finalSpreadsheetId);
        break;
      case 'full-sync':
      case 'sync':
        result = await fullSync(finalSpreadsheetId);
        break;
      default:
        return res.status(400).json({ 
          success: false,
          error: 'Invalid action. Valid actions: test, sheets-to-supabase, supabase-to-sheets, full-sync' 
        });
    }

    res.status(200).json({
      success: true,
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('API handler error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
}
