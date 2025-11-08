// Modern TailwindCSS v4.1.8 Configuration
// Optimized for production Docker builds with performance best practices

module.exports = {
  // Content sources for JIT compilation
  content: [
    './app/assets/tailwind/**/*.css',
    './app/components/**/*.{rb,html,erb}',
    './app/views/**/*.html.erb',
    './app/javascript/**/*.js',
    './app/helpers/**/*.rb'
  ],

  theme: {
    extend: {
      // Performance optimizations for spacing
      spacing: {
        '18': '4.5rem',
        '88': '22rem'
      },

      // Enhanced animation system
      animation: {
        'scale-in': 'scaleIn 0.3s ease-out forwards',
        'fade-in-up': 'fadeInUp 0.5s ease-out'
      },

      // Custom shadows for depth
      boxShadow: {
        'soft': '0 2px 8px rgba(0, 0, 0, 0.04)',
        'card': '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)'
      }
    }
  },

  plugins: [
    require('@tailwindcss/forms')({ strategy: 'class' }),
    require('@tailwindcss/typography')({ className: 'prose' })
  ],

  // Build optimizations for v4.1.8
  corePlugins: {
    preflight: false
  },

  // Safelist dynamic classes
  safelist: [
    'text-primary',
    'bg-container',
    'animate-scale-in',
    'kpi-value-fluid'
  ]
}
