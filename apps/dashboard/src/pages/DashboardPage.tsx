import React from 'react';
import { format } from 'date-fns';
import AIDetectionPieChart from '../components/AIDetectionPieChart';
import DetectionTimelineChart from '../components/DetectionTimelineChart';

interface Detection {
  id: string;
  tweetId: string;
  username: string;
  imageUrl: string;
  aiProbability: number | null;
  timestamp: string;
  processingTime?: number;
  apiProvider?: string;
  responseTweetId?: string;
}

const DashboardPage: React.FC = () => {
  const [detections, setDetections] = React.useState<Detection[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const fetchDetections = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // Try different possible worker URLs
        const workerUrls = [
          'http://localhost:8787',   // Standard Wrangler dev port
          'http://localhost:57550',  // Alternative port
          'http://localhost:59049',  // Current dev port from logs
          'https://truthscan-twitter-bot.your-username.workers.dev', // Production (if deployed)
        ];
        
        // Prepare authentication headers if credentials are available
        const authHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        
        // Check for Basic Auth credentials in environment variables
        // Note: In production, these would be set via build-time environment variables
        const basicAuthUsername = import.meta.env.VITE_BASIC_AUTH_USERNAME;
        const basicAuthPassword = import.meta.env.VITE_BASIC_AUTH_PASSWORD;
        
        if (basicAuthUsername && basicAuthPassword) {
          const credentials = btoa(`${basicAuthUsername}:${basicAuthPassword}`);
          authHeaders['Authorization'] = `Basic ${credentials}`;
          console.log('Using Basic Auth for API requests');
        } else {
          console.log('No Basic Auth credentials found, making unauthenticated request');
        }
        
        let apiData = null;
        let successful = false;
        
        for (const baseUrl of workerUrls) {
          if (successful) break;
          
          try {
            console.log(`Trying to fetch from: ${baseUrl}/api/detections`);
            const response = await fetch(`${baseUrl}/api/detections`, {
              method: 'GET',
              headers: authHeaders,
            });
            
            if (response.ok) {
              apiData = await response.json();
              console.log('Successfully fetched data from:', baseUrl);
              successful = true;
              break;
            } else if (response.status === 401) {
              console.log('Authentication required for API access');
              setError('Authentication required. Please configure VITE_BASIC_AUTH_USERNAME and VITE_BASIC_AUTH_PASSWORD environment variables.');
              return;
            } else if (response.status === 403) {
              console.log('Invalid credentials');
              setError('Invalid credentials. Please check your authentication configuration.');
              return;
            } else {
              console.log(`Failed to fetch from ${baseUrl}:`, response.status, response.statusText);
            }
          } catch (err) {
            console.log(`Connection failed to ${baseUrl}:`, err);
          }
        }
        
        if (!successful || !apiData) {
          setError('Unable to connect to the API. Please ensure the Cloudflare Worker is running.');
          return;
        }
        
        if (Array.isArray(apiData)) {
          setDetections(apiData);
        } else {
          setError('Invalid data format received from API');
        }
        
      } catch (err) {
        console.error('Fetch error:', err);
        setError('Failed to fetch detection data');
      } finally {
        setLoading(false);
      }
    };

    fetchDetections();

    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchDetections, 30000);
    return () => clearInterval(interval);
  }, []);

  const formatTimestamp = (timestamp: string) => {
    try {
      return format(new Date(timestamp), 'MMM dd, yyyy HH:mm:ss');
    } catch {
      return 'Invalid date';
    }
  };

  const getAIProbabilityBadge = (probability: number | null) => {
    if (probability === null || probability === undefined) {
      return (
        <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
          Processing...
        </span>
      );
    }
    
    // Handle both decimal (0-1) and percentage (0-100) formats
    // If the value is <= 1, assume it's a decimal; if > 1, assume it's already a percentage
    const percentage = probability <= 1 ? Math.round(probability * 100) : Math.round(probability);
    
    let colorClass = '';
    
    if (percentage >= 70) {
      colorClass = 'bg-red-100 text-red-800';
    } else if (percentage >= 40) {
      colorClass = 'bg-yellow-100 text-yellow-800';
    } else {
      colorClass = 'bg-green-100 text-green-800';
    }
    
    return (
      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${colorClass}`}>
        {percentage}% AI
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-xl text-gray-600">Loading detections...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="card bg-red-50 border-red-200">
          <div className="flex">
            <div className="flex-shrink-0">
              <span className="text-red-400 text-xl">⚠️</span>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                Error loading detections
              </h3>
              <div className="mt-2 text-sm text-red-700">
                <p>{error}</p>
              </div>
              <div className="mt-4">
                <button
                  onClick={() => window.location.reload()}
                  className="bg-red-100 px-3 py-2 rounded-md text-sm font-medium text-red-800 hover:bg-red-200"
                >
                  Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center">
                <span className="text-white text-sm font-medium">📊</span>
              </div>
            </div>
            <div className="ml-5 w-0 flex-1">
              <dl>
                <dt className="text-sm font-medium text-gray-500 truncate">
                  Total Detections
                </dt>
                <dd className="text-lg font-medium text-gray-900">
                  {detections.length}
                </dd>
              </dl>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="w-8 h-8 bg-red-500 rounded-full flex items-center justify-center">
                <span className="text-white text-sm font-medium">🤖</span>
              </div>
            </div>
            <div className="ml-5 w-0 flex-1">
              <dl>
                <dt className="text-sm font-medium text-gray-500 truncate">
                  AI Generated
                </dt>
                <dd className="text-lg font-medium text-gray-900">
                  {detections.filter(d => d.aiProbability !== null && d.aiProbability > 0.7).length}
                </dd>
              </dl>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center">
                <span className="text-white text-sm font-medium">👨‍🎨</span>
              </div>
            </div>
            <div className="ml-5 w-0 flex-1">
              <dl>
                <dt className="text-sm font-medium text-gray-500 truncate">
                  Human Made
                </dt>
                <dd className="text-lg font-medium text-gray-900">
                  {detections.filter(d => d.aiProbability !== null && d.aiProbability <= 0.3).length}
                </dd>
              </dl>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center">
            <div className="flex-shrink-0">
              <div className="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center">
                <span className="text-white text-sm font-medium">⏱️</span>
              </div>
            </div>
            <div className="ml-5 w-0 flex-1">
              <dl>
                <dt className="text-sm font-medium text-gray-500 truncate">
                  Processing
                </dt>
                <dd className="text-lg font-medium text-gray-900">
                  {detections.filter(d => d.aiProbability === null).length}
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      {/* Analytics Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            AI vs Human Breakdown
          </h3>
          <AIDetectionPieChart detections={detections} threshold={0.5} />
        </div>

        <div className="card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Detections Timeline (Last 7 Days)
          </h3>
          <DetectionTimelineChart detections={detections} days={7} />
        </div>
      </div>

      {/* Recent Detections Table */}
      <div className="card">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-gray-900">
            Recent Detections
          </h2>
          <div className="text-sm text-gray-500">
            Auto-refreshes every 30 seconds
          </div>
        </div>
        
        {detections.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 text-6xl mb-4">🔍</div>
            <p className="text-gray-500 text-lg mb-2">No detections yet</p>
            <p className="text-gray-400 text-sm">
              Detections will appear here when users mention the bot with images on Twitter.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Image
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    AI Probability
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Timestamp
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {detections.map((detection) => (
                  <tr key={detection.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="h-12 w-12 flex-shrink-0">
                        <img
                          className="h-12 w-12 rounded-lg object-cover border border-gray-200"
                          src={detection.imageUrl}
                          alt="Detected image"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDgiIGhlaWdodD0iNDgiIHZpZXdCb3g9IjAgMCA0OCA0OCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjRjNGNEY2Ii8+CjxwYXRoIGQ9Ik0yNCAzNkMzMC42Mjc0IDM2IDM2IDMwLjYyNzQgMzYgMjRDMzYgMTcuMzcyNiAzMC42Mjc0IDEyIDI0IDEyQzE3LjM3MjYgMTIgMTIgMTcuMzcyNiAxMiAyNEMxMiAzMC42Mjc0IDE3LjM3MjYgMzYgMjQgMzZaIiBzdHJva2U9IiM5Q0EzQUYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CjxwYXRoIGQ9Ik0yNCAyOEwyMSAyNUwyNCAyMkwyNyAyNUwyNCAyOFoiIHN0cm9rZT0iIzlDQTNBRiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KPC9zdmc+Cg==';
                          }}
                        />
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">
                        @{detection.username}
                      </div>
                      <div className="text-xs text-gray-500">
                        ID: {detection.id.substring(0, 8)}...
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getAIProbabilityBadge(detection.aiProbability)}
                      {detection.processingTime && (
                        <div className="text-xs text-gray-400 mt-1">
                          {(detection.processingTime / 1000).toFixed(1)}s
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatTimestamp(detection.timestamp)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                      <a
                        href={`https://twitter.com/i/status/${detection.tweetId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-900 hover:underline"
                      >
                        View Tweet
                      </a>
                      {detection.responseTweetId && (
                        <>
                          <span className="text-gray-300">|</span>
                          <a
                            href={`https://twitter.com/i/status/${detection.responseTweetId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-green-600 hover:text-green-900 hover:underline"
                          >
                            View Reply
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default DashboardPage; 