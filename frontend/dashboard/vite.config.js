import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// recharts and the d3 modules it bundles are most of the dashboard's weight and
// change far less often than the app code, so they get a chunk of their own the
// browser can keep cached across releases.
const CHART_LIBRARIES = /node_modules[\\/](recharts|recharts-scale|react-smooth|victory-vendor|d3-[^\\/]+|internmap|decimal\.js-light|lodash)[\\/]/

export default defineConfig({
  // Vite 8 transforms with Oxc, and @vitejs/plugin-react configures the
  // automatic JSX runtime for both the build and Vitest. The old esbuild JSX
  // option is ignored by Vite 8 and only produced a warning.
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Only the chart modules themselves. Capturing their dependencies
          // recursively would drag React into this chunk and make the landing
          // page, which draws no charts, preload all of it.
          groups: [{ name: 'charts', test: CHART_LIBRARIES, includeDependenciesRecursively: false }],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.{js,jsx}'],
  },
})
