import React from 'react';

interface MonitoringData {
  overview: {
    totalErrors: number;
    totalPageViews: number;
    uniquePages: number;
    botTraffic: number;
    totalDetections: number;
    avgProcessingTime: number;
    avgDetectionScore: number;
  };
  recentErrors: Array<{
    timestamp: number;
    level: string;
    message: string;
    event_type: string;
  }>;
  errorBreakdown: Array<{
    event_type: string;
    count: number;
  }>;
  healthStatus: {
    errorRate: number;
    status: string;
  };
}

interface MonitoringCardProps {
  data: MonitoringData | null;
  loading: boolean;
  error: string | null;
}

const MonitoringCard: React.FC<MonitoringCardProps> = ({ data, loading, error }) => {
  if (loading) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">System Monitoring</h3>
        <div className="flex items-center justify-center h-32">
          <div className="text-gray-500">Loading monitoring data...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card bg-red-50 border-red-200">
        <h3 className="text-lg font-semibold text-red-800 mb-4">System Monitoring</h3>
        <div className="text-red-700 text-sm">{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">System Monitoring</h3>
        <div className="text-gray-500">No monitoring data available</div>
      </div>
    );
  }

  const getHealthStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'text-green-600 bg-green-100';
      case 'warning': return 'text-yellow-600 bg-yellow-100';
      case 'critical': return 'text-red-600 bg-red-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  const formatProcessingTime = (timeMs: number) => {
    if (timeMs < 1000) {
      return `${Math.round(timeMs)}ms`;
    } else {
      return `${(timeMs / 1000).toFixed(1)}s`;
    }
  };

  return (
    <div className="space-y-6">
      {/* System Health Overview */}
      <div className="card">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-900">System Health</h3>
          <span className={`px-3 py-1 rounded-full text-sm font-medium ${getHealthStatusColor(data.healthStatus.status)}`}>
            {data.healthStatus.status.charAt(0).toUpperCase() + data.healthStatus.status.slice(1)}
          </span>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">{data.overview.totalErrors}</div>
            <div className="text-sm text-gray-500">Total Errors</div>
            <div className="text-xs text-gray-400">Last 24h</div>
          </div>
          
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">{data.overview.totalPageViews}</div>
            <div className="text-sm text-gray-500">Page Views</div>
            <div className="text-xs text-gray-400">Last 24h</div>
          </div>
          
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{data.overview.uniquePages}</div>
            <div className="text-sm text-gray-500">Unique Pages</div>
            <div className="text-xs text-gray-400">Last 24h</div>
          </div>
          
          <div className="text-center">
            <div className="text-2xl font-bold text-purple-600">
              {formatProcessingTime(data.overview.avgProcessingTime)}
            </div>
            <div className="text-sm text-gray-500">Avg Response</div>
            <div className="text-xs text-gray-400">Processing time</div>
          </div>
        </div>
      </div>

      {/* Detection Performance */}
      <div className="card">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Detection Performance</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-indigo-600">{data.overview.totalDetections}</div>
            <div className="text-sm text-gray-500">Total Detections</div>
          </div>
          
          <div className="text-center">
            <div className="text-2xl font-bold text-orange-600">
              {Math.round(data.overview.avgDetectionScore * 100)}%
            </div>
            <div className="text-sm text-gray-500">Avg AI Score</div>
          </div>
          
          <div className="text-center">
            <div className="text-2xl font-bold text-teal-600">
              {Math.round(data.healthStatus.errorRate * 100)}%
            </div>
            <div className="text-sm text-gray-500">Error Rate</div>
          </div>
        </div>
      </div>

      {/* Recent Errors */}
      {data.recentErrors.length > 0 && (
        <div className="card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Errors</h3>
          <div className="space-y-2">
            {data.recentErrors.slice(0, 5).map((error, index) => (
              <div key={index} className="flex items-start space-x-3 p-3 bg-red-50 rounded-lg border border-red-200">
                <div className="flex-shrink-0">
                  <span className="inline-block w-2 h-2 bg-red-400 rounded-full mt-2"></span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-red-800">{error.event_type}</div>
                  <div className="text-sm text-red-700">{error.message}</div>
                  <div className="text-xs text-red-600 mt-1">
                    {new Date(error.timestamp * 1000).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error Breakdown */}
      {data.errorBreakdown.length > 0 && (
        <div className="card">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Error Breakdown</h3>
          <div className="space-y-2">
            {data.errorBreakdown.map((errorType, index) => (
              <div key={index} className="flex justify-between items-center py-2 px-3 bg-gray-50 rounded">
                <span className="text-sm font-medium text-gray-700">{errorType.event_type}</span>
                <span className="text-sm text-gray-900 font-semibold">{errorType.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default MonitoringCard; 