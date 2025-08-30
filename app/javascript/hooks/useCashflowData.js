/**
 * Robust cashflow data fetching hook with request barrier pattern
 * Implements AbortController, SSR safety, and race condition prevention
 */

// Simple validation function instead of zod for now
const validateCashflowData = (data) => {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid data: must be an object');
  }
  
  if (!Array.isArray(data.nodes)) {
    throw new Error('Invalid data: nodes must be an array');
  }
  
  if (!Array.isArray(data.links)) {
    throw new Error('Invalid data: links must be an array');
  }
  
  return {
    ...data,
    currency_symbol: data.currency_symbol || '$'
  };
};

/**
 * Custom hook for fetching cashflow data with robust error handling
 * @param {Object} params - Fetch parameters
 * @param {string} params.startDate - Start date for the period
 * @param {string} params.endDate - End date for the period  
 * @param {Array} params.accounts - Account IDs to include
 * @param {string} params.householdId - Household ID
 * @param {string} params.period - Period key (e.g., 'last_30_days')
 * @returns {Object} { status, data, error, refresh }
 */
export function useCashflowData(params = {}) {
  // SSR safety guards
  const isSSR = typeof window === 'undefined' || typeof document === 'undefined';
  
  if (isSSR) {
    return {
      status: 'idle',
      data: null,
      error: null,
      refresh: () => {}
    };
  }

  // State management
  let state = {
    status: 'idle', // 'idle' | 'loading' | 'success' | 'error'
    data: null,
    error: null
  };

  // Request barrier pattern
  let activeRequestId = { current: 0 };
  let abortController = null;
  let subscribers = new Set();
  let debounceTimer = null;

  // Cleanup function
  const cleanup = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  // Notify all subscribers of state changes
  const notifySubscribers = () => {
    subscribers.forEach(callback => {
      try {
        callback(state);
      } catch (error) {
        console.error('Error in useCashflowData subscriber:', error);
      }
    });
  };

  // Update state and notify subscribers
  const setState = (newState) => {
    state = { ...state, ...newState };
    notifySubscribers();
  };

  // Build URL with parameters
  const buildUrl = (fetchParams) => {
    const url = new URL(window.location.origin + window.location.pathname);
    
    if (fetchParams.period) {
      url.searchParams.set('cashflow_period', fetchParams.period);
    }
    if (fetchParams.startDate) {
      url.searchParams.set('start_date', fetchParams.startDate);
    }
    if (fetchParams.endDate) {
      url.searchParams.set('end_date', fetchParams.endDate);
    }
    if (fetchParams.accounts && fetchParams.accounts.length > 0) {
      url.searchParams.set('accounts', fetchParams.accounts.join(','));
    }
    if (fetchParams.householdId) {
      url.searchParams.set('household_id', fetchParams.householdId);
    }

    return url.toString();
  };

  // Extract sankey data from HTML response
  const extractSankeyData = (html) => {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      
      const sankeyElement = doc.querySelector('[data-controller*="cashflow-fullscreen"]');
      if (!sankeyElement) {
        throw new Error('Sankey data element not found in response');
      }

      const dataAttr = sankeyElement.getAttribute('data-cashflow-fullscreen-sankey-data-value');
      const currencyAttr = sankeyElement.getAttribute('data-cashflow-fullscreen-currency-symbol-value');
      const periodAttr = sankeyElement.getAttribute('data-cashflow-fullscreen-period-value');

      if (!dataAttr) {
        throw new Error('Sankey data attribute not found');
      }

      const rawData = JSON.parse(dataAttr);
      
      // Validate with simple validation function
      const validatedData = validateCashflowData({
        ...rawData,
        currency_symbol: currencyAttr || '$'
      });

      return {
        ...validatedData,
        period: periodAttr
      };
    } catch (error) {
      console.error('Failed to extract sankey data:', error);
      throw new Error(`Data extraction failed: ${error.message}`);
    }
  };

  // Core fetch function with request barrier
  const fetchData = async (fetchParams) => {
    // Increment request ID and abort previous request
    activeRequestId.current += 1;
    const currentRequestId = activeRequestId.current;
    
    if (abortController) {
      abortController.abort();
    }
    
    abortController = new AbortController();
    const signal = abortController.signal;

    try {
      setState({ status: 'loading', error: null });

      const url = buildUrl(fetchParams);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/html',
          'X-Requested-With': 'XMLHttpRequest',
          'Turbo-Frame': 'cashflow-frame'
        },
        signal
      });

      // Check if this request is still the active one
      if (currentRequestId !== activeRequestId.current) {
        return; // Request was superseded, ignore response
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      
      // Final check before setting state
      if (currentRequestId !== activeRequestId.current) {
        return; // Request was superseded during response parsing
      }

      const data = extractSankeyData(html);
      
      setState({
        status: 'success',
        data,
        error: null
      });

    } catch (error) {
      // Only set error state if this request is still active
      if (currentRequestId === activeRequestId.current) {
        if (error.name === 'AbortError') {
          // Don't treat aborted requests as errors
          return;
        }
        
        console.error('Cashflow data fetch failed:', error);
        setState({
          status: 'error',
          error: error.message || 'Failed to fetch cashflow data'
        });
      }
    } finally {
      // Always clean up loading state for this specific request
      if (currentRequestId === activeRequestId.current) {
        // If we're still loading, something went wrong
        if (state.status === 'loading') {
          setState({ status: 'error', error: 'Request completed but status not updated' });
        }
      }
    }
  };

  // Debounced fetch to prevent rapid re-fetch bursts
  const debouncedFetch = (fetchParams, delay = 150) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    
    debounceTimer = setTimeout(() => {
      fetchData(fetchParams);
    }, delay);
  };

  // Public refresh function
  const refresh = (newParams = params, immediate = false) => {
    const mergedParams = { ...params, ...newParams };
    
    if (immediate) {
      fetchData(mergedParams);
    } else {
      debouncedFetch(mergedParams);
    }
  };

  // Subscribe to state changes
  const subscribe = (callback) => {
    subscribers.add(callback);
    
    // Return unsubscribe function
    return () => {
      subscribers.delete(callback);
    };
  };

  // Initialize with current params if provided
  if (params && Object.keys(params).length > 0) {
    // Use setTimeout to avoid blocking the main thread
    setTimeout(() => {
      fetchData(params);
    }, 0);
  }

  // Return public API
  return {
    get status() { return state.status; },
    get data() { return state.data; },
    get error() { return state.error; },
    refresh,
    subscribe,
    cleanup
  };
}

// Factory function for creating hook instances
export function createCashflowDataHook(initialParams = {}) {
  return useCashflowData(initialParams);
}

// Export the validation function
export { validateCashflowData };

export default useCashflowData;