/**
 * ResizeObserver utility with SSR guards, debouncing, and proper cleanup
 * Provides a clean interface for observing element size changes
 */

export class ResizeObserverManager {
  constructor() {
    this.observers = new Map();
    this.isSSR = typeof window === 'undefined' || typeof document === 'undefined';
  }

  /**
   * Observe an element for size changes
   * @param {HTMLElement} element - Element to observe
   * @param {Function} callback - Callback function to call on resize
   * @param {Object} options - Configuration options
   * @param {number} options.debounceMs - Debounce delay in milliseconds (default: 100)
   * @param {Object} options.initialSize - Initial size fallback for SSR
   * @returns {Function} Cleanup function
   */
  observe(element, callback, options = {}) {
    const {
      debounceMs = 100,
      initialSize = { width: 800, height: 600 }
    } = options;

    // SSR guard - return no-op cleanup function
    if (this.isSSR || !element) {
      // Provide initial size for SSR compatibility
      setTimeout(() => callback(initialSize), 0);
      return () => {};
    }

    // Check if ResizeObserver is supported
    if (typeof ResizeObserver === 'undefined') {
      console.warn('ResizeObserver not supported, falling back to window resize');
      return this.fallbackToWindowResize(element, callback, debounceMs);
    }

    const observerId = this.generateObserverId(element);
    let debounceTimer = null;
    let lastSize = null;

    const debouncedCallback = (entries) => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        const entry = entries[0];
        if (!entry) return;

        const { width, height } = entry.contentRect;
        
        // Only trigger callback if size actually changed
        const currentSize = { width: Math.round(width), height: Math.round(height) };
        if (!lastSize || lastSize.width !== currentSize.width || lastSize.height !== currentSize.height) {
          lastSize = currentSize;
          callback(currentSize);
        }
      }, debounceMs);
    };

    const observer = new ResizeObserver(debouncedCallback);
    observer.observe(element);

    // Store observer for cleanup
    this.observers.set(observerId, {
      observer,
      element,
      debounceTimer: () => debounceTimer,
      cleanup: () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        observer.disconnect();
        this.observers.delete(observerId);
      }
    });

    // Trigger initial measurement
    requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const initialMeasurement = { 
          width: Math.round(rect.width), 
          height: Math.round(rect.height) 
        };
        lastSize = initialMeasurement;
        callback(initialMeasurement);
      }
    });

    // Return cleanup function
    return () => {
      const observerData = this.observers.get(observerId);
      if (observerData) {
        observerData.cleanup();
      }
    };
  }

  /**
   * Fallback for browsers without ResizeObserver support
   */
  fallbackToWindowResize(element, callback, debounceMs) {
    let debounceTimer = null;
    let lastSize = null;

    const handleResize = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        if (!element.isConnected) return;
        
        const rect = element.getBoundingClientRect();
        const currentSize = { 
          width: Math.round(rect.width), 
          height: Math.round(rect.height) 
        };
        
        if (!lastSize || lastSize.width !== currentSize.width || lastSize.height !== currentSize.height) {
          lastSize = currentSize;
          callback(currentSize);
        }
      }, debounceMs);
    };

    window.addEventListener('resize', handleResize);
    
    // Initial measurement
    handleResize();

    return () => {
      window.removeEventListener('resize', handleResize);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }

  /**
   * Generate unique observer ID
   */
  generateObserverId(element) {
    return `observer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up all observers
   */
  cleanup() {
    this.observers.forEach(({ cleanup }) => cleanup());
    this.observers.clear();
  }

  /**
   * Get current observer count (for debugging)
   */
  getObserverCount() {
    return this.observers.size;
  }
}

// Export singleton instance
export const resizeObserverManager = new ResizeObserverManager();

/**
 * Hook-like function for easier usage in Stimulus controllers
 * @param {HTMLElement} element - Element to observe
 * @param {Function} callback - Callback function
 * @param {Object} options - Configuration options
 * @returns {Function} Cleanup function
 */
export function useResizeObserver(element, callback, options = {}) {
  return resizeObserverManager.observe(element, callback, options);
}

/**
 * Utility to get element dimensions safely
 * @param {HTMLElement} element - Element to measure
 * @param {Object} fallback - Fallback dimensions
 * @returns {Object} Dimensions object with width and height
 */
export function getElementDimensions(element, fallback = { width: 800, height: 600 }) {
  if (typeof window === 'undefined' || !element) {
    return fallback;
  }

  try {
    const rect = element.getBoundingClientRect();
    return {
      width: Math.round(rect.width) || fallback.width,
      height: Math.round(rect.height) || fallback.height
    };
  } catch (error) {
    console.warn('Failed to get element dimensions:', error);
    return fallback;
  }
}

export default {
  ResizeObserverManager,
  resizeObserverManager,
  useResizeObserver,
  getElementDimensions
};