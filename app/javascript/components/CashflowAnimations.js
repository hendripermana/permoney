/**
 * Cashflow animation components with Framer Motion
 * Includes prefers-reduced-motion support and accessibility
 */

import { createElement } from "react";
import { motion, AnimatePresence } from 'framer-motion';

// Check for reduced motion preference
const prefersReducedMotion = () => {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

// Animation variants with reduced motion support
const createVariants = (fullAnimation, reducedAnimation = {}) => {
  return prefersReducedMotion() ? reducedAnimation : fullAnimation;
};

// Loading overlay animation
export const LoadingOverlay = ({ isVisible, children, className = '' }) => {
  const overlayVariants = createVariants(
    {
      hidden: { opacity: 0, scale: 0.95 },
      visible: { 
        opacity: 1, 
        scale: 1,
        transition: {
          duration: 0.3,
          ease: 'easeOut'
        }
      },
      exit: { 
        opacity: 0, 
        scale: 0.95,
        transition: {
          duration: 0.2,
          ease: 'easeIn'
        }
      }
    },
    {
      hidden: { opacity: 0 },
      visible: { opacity: 1 },
      exit: { opacity: 0 }
    }
  );

  return createElement(
    AnimatePresence,
    null,
    isVisible
      ? createElement(
          motion.div,
          {
            className: `absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm z-10 flex items-center justify-center pointer-events-none ${className}`,
            variants: overlayVariants,
            initial: "hidden",
            animate: "visible",
            exit: "exit",
          },
          children
        )
      : null
  );
};

// Progress arc animation
export const ProgressArc = ({ progress = 0, size = 48, strokeWidth = 4, className = '' }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const strokeDasharray = circumference;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  const arcVariants = createVariants(
    {
      hidden: { strokeDashoffset: circumference },
      visible: { 
        strokeDashoffset,
        transition: {
          duration: 1.5,
          ease: 'easeInOut'
        }
      }
    },
    {
      hidden: { opacity: 0 },
      visible: { opacity: 1 }
    }
  );

  return createElement(
    'div',
    { className: `relative ${className}`, style: { width: size, height: size } },
    createElement(
      'svg',
      { width: size, height: size, className: 'transform -rotate-90' },
      [
        createElement('circle', {
          key: 'bg',
          cx: size / 2,
          cy: size / 2,
          r: radius,
          stroke: 'currentColor',
          strokeWidth: strokeWidth,
          fill: 'none',
          className: 'text-gray-200 dark:text-gray-700',
        }),
        createElement(motion.circle, {
          key: 'progress',
          cx: size / 2,
          cy: size / 2,
          r: radius,
          stroke: 'currentColor',
          strokeWidth: strokeWidth,
          fill: 'none',
          strokeLinecap: 'round',
          className: 'text-blue-500',
          style: {
            strokeDasharray,
            strokeDashoffset: circumference,
          },
          variants: arcVariants,
          initial: 'hidden',
          animate: 'visible',
        }),
      ]
    )
  );
};

// Loading spinner with text
export const LoadingSpinner = ({ text = 'Loading...', className = '' }) => {
  const spinnerVariants = createVariants(
    {
      spin: {
        rotate: 360,
        transition: {
          duration: 1,
          ease: 'linear',
          repeat: Infinity
        }
      }
    },
    {
      spin: { opacity: 1 }
    }
  );

  const textVariants = createVariants(
    {
      hidden: { opacity: 0, y: 10 },
      visible: { 
        opacity: 1, 
        y: 0,
        transition: {
          delay: 0.2,
          duration: 0.3
        }
      }
    },
    {
      hidden: { opacity: 0 },
      visible: { opacity: 1 }
    }
  );

  return createElement(
    'div',
    { className: `flex flex-col items-center gap-3 ${className}` },
    [
      createElement(motion.div, {
        key: 'spinner',
        className: 'w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full',
        variants: spinnerVariants,
        animate: 'spin',
      }),
      createElement(
        motion.span,
        {
          key: 'text',
          className: 'text-sm font-medium text-gray-600 dark:text-gray-300',
          variants: textVariants,
          initial: 'hidden',
          animate: 'visible',
        },
        text
      ),
    ]
  );
};

// Chart transition wrapper
export const ChartTransition = ({ children, isLoading, className = '' }) => {
  const chartVariants = createVariants(
    {
      hidden: { opacity: 0, scale: 0.98 },
      visible: { 
        opacity: 1, 
        scale: 1,
        transition: {
          duration: 0.4,
          ease: 'easeOut'
        }
      },
      loading: {
        opacity: 0.3,
        scale: 0.98,
        transition: {
          duration: 0.2
        }
      }
    },
    {
      hidden: { opacity: 0 },
      visible: { opacity: 1 },
      loading: { opacity: 0.5 }
    }
  );

  return createElement(
    motion.div,
    {
      className,
      variants: chartVariants,
      initial: 'hidden',
      animate: isLoading ? 'loading' : 'visible',
    },
    children
  );
};

// Stale data overlay
export const StaleDataOverlay = ({ isVisible, onRetry, className = '' }) => {
  const overlayVariants = createVariants(
    {
      hidden: { opacity: 0, y: -10 },
      visible: { 
        opacity: 1, 
        y: 0,
        transition: {
          duration: 0.3,
          ease: 'easeOut'
        }
      }
    },
    {
      hidden: { opacity: 0 },
      visible: { opacity: 1 }
    }
  );

  return createElement(
    AnimatePresence,
    null,
    isVisible
      ? createElement(
          motion.div,
          {
            className: `absolute top-4 left-1/2 transform -translate-x-1/2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-4 py-2 shadow-sm z-20 pointer-events-auto ${className}`,
            variants: overlayVariants,
            initial: 'hidden',
            animate: 'visible',
            exit: 'hidden',
          },
          createElement(
            'div',
            { className: 'flex items-center gap-3' },
            [
              createElement(
                'div',
                { key: 'left', className: 'flex items-center gap-2' },
                [
                  createElement('div', { key: 'dot', className: 'w-2 h-2 bg-yellow-500 rounded-full animate-pulse' }),
                  createElement(
                    'span',
                    { key: 'text', className: 'text-sm font-medium text-yellow-800 dark:text-yellow-200' },
                    'Still loading...'
                  ),
                ]
              ),
              onRetry
                ? createElement(
                    'button',
                    {
                      key: 'retry',
                      onClick: onRetry,
                      className:
                        'text-sm text-yellow-700 dark:text-yellow-300 hover:text-yellow-900 dark:hover:text-yellow-100 underline',
                    },
                    'Retry'
                  )
                : null,
            ]
          )
        )
      : null
  );
};

// Link highlight animation for showing changes
export const LinkHighlight = ({ isActive, children, className = '' }) => {
  const highlightVariants = createVariants(
    {
      inactive: { 
        filter: 'brightness(1) saturate(1)',
        transition: { duration: 0.3 }
      },
      active: {
        filter: 'brightness(1.2) saturate(1.4)',
        transition: {
          duration: 0.6,
          ease: 'easeInOut',
          repeat: 2,
          repeatType: 'reverse'
        }
      }
    },
    {
      inactive: { opacity: 1 },
      active: { opacity: 1 }
    }
  );

  return createElement(
    motion.div,
    {
      className,
      variants: highlightVariants,
      animate: isActive ? 'active' : 'inactive',
    },
    children
  );
};

// Error state animation
export const ErrorState = ({ message, onRetry, className = '' }) => {
  const errorVariants = createVariants(
    {
      hidden: { opacity: 0, scale: 0.9 },
      visible: { 
        opacity: 1, 
        scale: 1,
        transition: {
          duration: 0.3,
          ease: 'easeOut'
        }
      }
    },
    {
      hidden: { opacity: 0 },
      visible: { opacity: 1 }
    }
  );

  return createElement(
    motion.div,
    {
      className: `flex flex-col items-center gap-4 p-6 pointer-events-auto ${className}`,
      variants: errorVariants,
      initial: 'hidden',
      animate: 'visible',
    },
    [
      createElement(
        'div',
        { key: 'iconwrap', className: 'w-12 h-12 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center' },
        createElement(
          'svg',
          { key: 'icon', className: 'w-6 h-6 text-red-600 dark:text-red-400', fill: 'none', stroke: 'currentColor', viewBox: '0 0 24 24' },
          createElement('path', { strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2, d: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z' })
        )
      ),
      createElement(
        'div',
        { key: 'content', className: 'text-center' },
        [
          createElement('p', { key: 'title', className: 'text-sm font-medium text-red-800 dark:text-red-200 mb-2' }, 'Failed to load cashflow data'),
          message ? createElement('p', { key: 'msg', className: 'text-xs text-red-600 dark:text-red-400 mb-3' }, message) : null,
          onRetry
            ? createElement(
                'button',
                { key: 'retry', onClick: onRetry, className: 'px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors' },
                'Try Again'
              )
            : null,
        ]
      ),
    ]
  );
};

export default {
  LoadingOverlay,
  ProgressArc,
  LoadingSpinner,
  ChartTransition,
  StaleDataOverlay,
  LinkHighlight,
  ErrorState
};