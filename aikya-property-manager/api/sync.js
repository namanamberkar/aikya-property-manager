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
    const auth = new google.auth.GoogleAuth({
      credentials: {
        "type": "service_account",
        "project_id": process.env.GOOGLE_PROJECT_ID,
        "private_key_id": process.env.GOOGLE_PRIVATE_KEY_ID,
        "private_key": process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        "client_email": process.env.GOOGLE_CLIENT_EMAIL,
        "client_id": process.env.GOOGLE_CLIENT_ID
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    return sheets;
  } catch (error) {
    console.error('Google Sheets authentication failed:', error);
    throw error;
  }
}

function extractSpreadsheetId(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

// ADD YOUR FUNCTIONS HERE - START

async function pushToSheets(spreadsheetId) {
  try {
    const sheets = await authenticateGoogleSheets();
    
    // Get data from Supabase
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .order('check_in_date', { ascending: true });

    if (error) throw new Error(`Supabase query failed: ${error.message}`);

    // Prepare headers - EXACT match with Supabase columns
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

    // Prepare data rows - EXACT order as headers
    const values = bookings.map(booking => [
      booking.id,
      booking.guest_name,
      booking.phone_number || '',
      booking.check_in_date,
      booking.check_out_date,
      booking.property_id,
      booking.property_name,
      booking.source,
      booking.amount_paid,
      booking.sync_status || 'Not Configured',
      booking.booked_at
    ]);

    // Clear existing data and write new data
    await sheets.spreadsheets.values.clear({
      spreadsheetId: spreadsheetId,
      range: 'Bookings!A1:K',
    });

    // Write headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: 'Bookings!A1',
      valueInputOption: 'RAW',
      resource: {
        values: [headers]
      }
    });

    // Write data
    if (values.length > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: 'Bookings!A2',
        valueInputOption: 'RAW',
        resource: {
          values: values
        }
      });
    }

    return {
      success: true,
      message: `Pushed ${bookings.length} bookings to Google Sheets successfully`
    };
  } catch (error) {
    throw new Error(`Push to Sheets failed: ${error.message}`);
  }
}

async function pullFromSheets(spreadsheetId) {
  try {
    const sheets = await authenticateGoogleSheets();
    
    // Get data from Google Sheets
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: 'Bookings!A2:K', // Skip header row
    });

    const rows = response.data.values || [];
    
    let successCount = 0;
    let errorCount = 0;

    // Process each row and update Supabase
    for (const row of rows) {
      try {
        if (!row[0] || !row[1]) continue; // Skip rows without ID or guest name

        const bookingData = {
          id: row[0], // id
          guest_name: row[1], // guest_name
          phone_number: row[2] || '', // phone_number
          check_in_date: row[3], // check_in_date
          check_out_date: row[4], // check_out_date
          property_id: row[5] || '', // property_id
          property_name: row[6] || '', // property_name
          source: row[7] || 'Direct', // source
          amount_paid: parseFloat(row[8]) || 0, // amount_paid
          sync_status: row[9] || 'Synced', // sync_status
          booked_at: row[10] || new Date().toISOString() // booked_at
        };

        // Upsert into Supabase
        const { error } = await supabase
          .from('bookings')
          .upsert(bookingData, { onConflict: 'id' });

        if (error) {
          console.error('Error upserting booking:', error);
          errorCount++;
        } else {
          successCount++;
        }
      } catch (rowError) {
        console.error('Error processing row:', rowError);
        errorCount++;
      }
    }

    return {
      success: true,
      message: `Pulled ${successCount} bookings from Google Sheets. ${errorCount} errors.`
    };
  } catch (error) {
    throw new Error(`Pull from Sheets failed: ${error.message}`);
  }
}

// ADD YOUR FUNCTIONS HERE - END

async function testConnections(spreadsheetId) {
  try {
    // Test Supabase connection
    const { data: supabaseTest, error } = await supabase
      .from('bookings')
      .select('id')
      .limit(1);

    if (error) throw new Error(`Supabase: ${error.message}`);

    // Test Google Sheets connection
    const sheets = await authenticateGoogleSheets();
    
    if (spreadsheetId) {
      await sheets.spreadsheets.get({
        spreadsheetId: spreadsheetId
      });
    }

    return {
      success: true,
      message: 'Both Supabase and Google Sheets connections are working'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function fullSync(spreadsheetId) {
  try {
    const pushResult = await pushToSheets(spreadsheetId);
    
    return {
      success: true,
      message: `Full sync completed: ${pushResult.message}`
    };
  } catch (error) {
    throw new Error(`Full sync failed: ${error.message}`);
  }
}

// MAIN API HANDLER
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, spreadsheetId, spreadsheetUrl } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    const finalSpreadsheetId = spreadsheetId || extractSpreadsheetId(spreadsheetUrl);

    if (!finalSpreadsheetId && action !== 'test') {
      return res.status(400).json({ error: 'Spreadsheet ID or URL is required' });
    }

    let result;

    switch (action) {
      case 'test':
        result = await testConnections(finalSpreadsheetId);
        break;
      case 'sheets-to-supabase':
        result = await pullFromSheets(finalSpreadsheetId);
        break;
      case 'supabase-to-sheets':
        result = await pushToSheets(finalSpreadsheetId);
        break;
      case 'full-sync':
        result = await fullSync(finalSpreadsheetId);
        break;
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ 
      error: error.message || 'Internal server error',
      success: false 
    });
  }
}