import React from 'react';

const AnalyticsPage: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">
          📈 Analytics Dashboard
        </h2>
        <p className="text-gray-600">
          Coming soon: Charts and detailed analytics will be implemented in Task 9.
        </p>
        
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              AI vs Human Breakdown
            </h3>
            <p className="text-gray-500">Pie chart coming soon</p>
          </div>
          
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Detections Over Time
            </h3>
            <p className="text-gray-500">Timeline chart coming soon</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnalyticsPage; 