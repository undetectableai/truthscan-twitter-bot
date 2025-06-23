import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';

interface Detection {
  id: string;
  aiProbability: number | null;
}

interface AIDetectionPieChartProps {
  detections: Detection[];
  threshold?: number; // Configurable threshold for AI vs Real classification
}

const AIDetectionPieChart: React.FC<AIDetectionPieChartProps> = ({ 
  detections, 
  threshold = 0.5 
}) => {
  // Process detection data for pie chart
  const processedData = React.useMemo(() => {
    const validDetections = detections.filter(d => d.aiProbability !== null);
    
    if (validDetections.length === 0) {
      return [];
    }
    
    // Use threshold logic: if probability > threshold (0.5 default), it's AI
    // Handle both decimal (0-1) and percentage (0-100) formats
    const aiCount = validDetections.filter(d => {
      const prob = d.aiProbability!;
      const normalizedProb = prob <= 1 ? prob : prob / 100;
      return normalizedProb > threshold;
    }).length;
    
    const humanCount = validDetections.length - aiCount;
    
    return [
      { 
        name: 'AI Generated', 
        value: aiCount, 
        percentage: Math.round((aiCount / validDetections.length) * 100),
        color: '#ef4444' // Red for AI
      },
      { 
        name: 'Human Made', 
        value: humanCount, 
        percentage: Math.round((humanCount / validDetections.length) * 100),
        color: '#22c55e' // Green for Human
      }
    ].filter(item => item.value > 0); // Only show non-zero categories
  }, [detections, threshold]);

  // Custom tooltip to show percentage and count
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white p-3 border border-gray-200 rounded-lg shadow-lg">
          <p className="font-medium text-gray-900">{data.name}</p>
          <p className="text-sm text-gray-600">
            Count: <span className="font-medium">{data.value}</span>
          </p>
          <p className="text-sm text-gray-600">
            Percentage: <span className="font-medium">{data.percentage}%</span>
          </p>
        </div>
      );
    }
    return null;
  };

  // Empty state
  if (processedData.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-500">
        <div className="text-center">
          <div className="text-4xl mb-2">📊</div>
          <p>No detection data available</p>
          <p className="text-sm">Charts will appear when detections are processed</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={processedData}
            cx="50%"
            cy="50%"
            labelLine={false}
            label={({ name, percentage }) => `${name}: ${percentage}%`}
            outerRadius={80}
            fill="#8884d8"
            dataKey="value"
          >
            {processedData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend 
            verticalAlign="bottom" 
            height={36}
            iconType="circle"
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
};

export default AIDetectionPieChart; 