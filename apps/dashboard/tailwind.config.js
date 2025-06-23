/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'ai-red': '#ef4444',
        'ai-yellow': '#f59e0b', 
        'ai-green': '#10b981',
        'brand-blue': '#3b82f6'
      }
    },
  },
  plugins: [],
} 