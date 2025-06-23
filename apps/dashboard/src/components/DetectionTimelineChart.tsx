import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { format, parseISO, subDays } from 'date-fns';

interface Detection {
  id: string;
  timestamp: string;
  aiProbability: number | null;
}

interface DetectionTimelineChartProps {
  detections: Detection[];
  days?: number; // Number of days to show in the timeline
}

const DetectionTimelineChart: React.FC<DetectionTimelineChartProps> = ({ 
  detections, 
  days = 7 
}) => {
  // Process detection data for timeline chart
  const processedData = React.useMemo(() => {
    if (detections.length === 0) {
      return [];
    }

    // Create date range for the last N days
    const endDate = new Date();
    
    // Initialize data structure for each day
    const dateMap = new Map<string, {
      date: string;
      displayDate: string;
      total: number;
      ai: number;
      human: number;
      processing: number;
    }>();

    // Fill in all days in the range with zero counts
    for (let i = 0; i < days; i++) {
      const currentDate = subDays(endDate, days - 1 - i);
      const dateKey = format(currentDate, 'yyyy-MM-dd');
      const displayDate = format(currentDate, 'MMM dd');
      
      dateMap.set(dateKey, {
        date: dateKey,
        displayDate,
        total: 0,
        ai: 0,
        human: 0,
        processing: 0
      });
    }

    // Aggregate detections by day
    detections.forEach(detection => {
      try {
        const detectionDate = parseISO(detection.timestamp);
        const dateKey = format(detectionDate, 'yyyy-MM-dd');
        
        const dayData = dateMap.get(dateKey);
        if (dayData) {
          dayData.total += 1;
          
          if (detection.aiProbability === null) {
            dayData.processing += 1;
          } else {
            // Handle both decimal (0-1) and percentage (0-100) formats
            const prob = detection.aiProbability;
            const normalizedProb = prob <= 1 ? prob : prob / 100;
            
            if (normalizedProb > 0.5) {
              dayData.ai += 1;
            } else {
              dayData.human += 1;
            }
          }
        }
      } catch (error) {
        console.warn('Invalid timestamp in detection:', detection.timestamp);
      }
    });

    // Convert map to array and sort by date
    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [detections, days]);

  // Custom tooltip
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white p-3 border border-gray-200 rounded-lg shadow-lg">
          <p className="font-medium text-gray-900 mb-2">{data.displayDate}</p>
          <div className="space-y-1">
            <p className="text-sm text-gray-600">
              Total: <span className="font-medium text-blue-600">{data.total}</span>
            </p>
            <p className="text-sm text-gray-600">
              AI Generated: <span className="font-medium text-red-600">{data.ai}</span>
            </p>
            <p className="text-sm text-gray-600">
              Human Made: <span className="font-medium text-green-600">{data.human}</span>
            </p>
            {data.processing > 0 && (
              <p className="text-sm text-gray-600">
                Processing: <span className="font-medium text-purple-600">{data.processing}</span>
              </p>
            )}
          </div>
        </div>
      );
    }
    return null;
  };

  // Empty state
  if (processedData.length === 0 || processedData.every(d => d.total === 0)) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-500">
        <div className="text-center">
          <div className="text-4xl mb-2">📈</div>
          <p>No detection timeline data</p>
          <p className="text-sm">Timeline will show when detections are processed</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={processedData}
          margin={{
            top: 5,
            right: 30,
            left: 20,
            bottom: 5,
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis 
            dataKey="displayDate" 
            tick={{ fontSize: 12 }}
            tickLine={{ stroke: '#d1d5db' }}
          />
          <YAxis 
            tick={{ fontSize: 12 }}
            tickLine={{ stroke: '#d1d5db' }}
            allowDecimals={false}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend />
          <Bar 
            dataKey="ai" 
            stackId="detections"
            name="AI Generated" 
            fill="#ef4444" 
            radius={[0, 0, 0, 0]}
          />
          <Bar 
            dataKey="human" 
            stackId="detections"
            name="Human Made" 
            fill="#22c55e" 
            radius={[0, 0, 0, 0]}
          />
          <Bar 
            dataKey="processing" 
            stackId="detections"
            name="Processing" 
            fill="#a855f7" 
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default DetectionTimelineChart; 