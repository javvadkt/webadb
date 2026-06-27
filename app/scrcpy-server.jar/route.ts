import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const url = 'https://github.com/Genymobile/scrcpy/releases/download/v2.1/scrcpy-server-v2.1';
    
    // Server-side fetch doesn't suffer from browser CORS limitations
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });

    if (!response.ok) {
      return new NextResponse(`Failed to fetch scrcpy-server from GitHub: ${response.statusText} (${response.status})`, { status: response.status });
    }

    const data = await response.arrayBuffer();

    return new NextResponse(data, {
      headers: {
        'Content-Type': 'application/java-archive',
        'Content-Disposition': 'attachment; filename="scrcpy-server.jar"',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400', // Cache for 24 hours on CDN and browser
      },
    });
  } catch (error: any) {
    console.error('Error proxying scrcpy-server:', error);
    return new NextResponse(`Internal Server Error proxying scrcpy-server: ${error.message || error}`, { status: 500 });
  }
}
