import React from 'react';

const SettingsPage: React.FC = () => {
  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">
          ⚙️ Settings
        </h2>
        <p className="text-gray-600 mb-6">
          Configure your Truthscan Twitter Bot dashboard settings.
        </p>
        
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-3">
              Bot Configuration
            </h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Bot Username
                  </label>
                  <input 
                    type="text" 
                    value="@truth_scan" 
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Polling Interval
                  </label>
                  <select 
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100"
                  >
                    <option>30 seconds</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-3">
              AI Detection Thresholds
            </h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    High Confidence (AI)
                  </label>
                  <input 
                    type="number" 
                    value="70" 
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100"
                  />
                  <span className="text-xs text-gray-500">% threshold</span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Medium Confidence
                  </label>
                  <input 
                    type="number" 
                    value="30" 
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100"
                  />
                  <span className="text-xs text-gray-500">% threshold</span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Low Confidence (Human)
                  </label>
                  <input 
                    type="number" 
                    value="30" 
                    disabled
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-100"
                  />
                  <span className="text-xs text-gray-500">% threshold (below)</span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-3">
              Dashboard Preferences
            </h3>
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="space-y-4">
                <div className="flex items-center">
                  <input 
                    id="auto-refresh" 
                    type="checkbox" 
                    defaultChecked
                    disabled
                    className="h-4 w-4 text-brand-blue border-gray-300 rounded"
                  />
                  <label htmlFor="auto-refresh" className="ml-2 text-sm text-gray-700">
                    Auto-refresh dashboard every 30 seconds
                  </label>
                </div>
                <div className="flex items-center">
                  <input 
                    id="notifications" 
                    type="checkbox" 
                    disabled
                    className="h-4 w-4 text-brand-blue border-gray-300 rounded"
                  />
                  <label htmlFor="notifications" className="ml-2 text-sm text-gray-700">
                    Browser notifications for new detections
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-4">
            <p className="text-sm text-gray-500">
              <strong>Note:</strong> Settings are currently read-only. Configuration will be implemented in future updates.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage; 