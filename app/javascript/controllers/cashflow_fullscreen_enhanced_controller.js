/**
 * Enhanced Cashflow Controller with robust data fetching and animations
 * Replaces the existing cashflow fullscreen controller with improved architecture
 */

import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = {
    sankeyData: Object,
    currencySymbol: { type: String, default: "$" },
    period: { type: String, default: "last_30_days" },
    householdId: String,
    accounts: Array,
    periodOptions: Array,
  };

  connect() {
    this.fullscreenModal = null;
    this.currentRequest = null;
    this.isUnmounted = false;
    this.lastClickTime = 0;
    this.debounceDelay = 200;

    // Bind methods to preserve context
    this.escapeHandler = this.handleEscape.bind(this);
    this.handlePeriodChangeDebounced = this.debounce(this.handlePeriodChange.bind(this), 200);

    // Update initial aria-pressed state
    this.updateAriaPressed();
  }

  disconnect() {
    this.cleanup();
  }

  // Debounce utility
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  clearWatchdogTimer() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // Handle period changes (fetch new data via server-rendered flow)
  async handlePeriodChange(newPeriod) {
    if (!newPeriod || newPeriod === this.periodValue) return;

    const wasFullscreen = this.isFullscreenOpen();
    const url = new URL(window.location);
    url.searchParams.set("cashflow_period", newPeriod);

    if (wasFullscreen) this.showBasicLoading();

    if (this.currentRequest) this.currentRequest.abort();
    this.currentRequest = new AbortController();

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "text/html",
          "X-Requested-With": "XMLHttpRequest",
          "Turbo-Frame": "cashflow-frame",
        },
        signal: this.currentRequest.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      const newSankeyElement = doc.querySelector('[data-controller*="cashflow-fullscreen"]');
      if (!newSankeyElement) throw new Error("Sankey data element not found");

      const readAttr = (el, base) =>
        el.getAttribute(`data-cashflow-fullscreen-enhanced-${base}-value`) ||
        el.getAttribute(`data-cashflow-fullscreen-${base}-value`);

      const dataAttr = readAttr(newSankeyElement, "sankey-data");
      const currencyAttr = readAttr(newSankeyElement, "currency-symbol");
      const periodAttr = readAttr(newSankeyElement, "period");
      if (!dataAttr) throw new Error("Sankey data attribute missing");

      const newSankeyData = JSON.parse(dataAttr);
      const newCurrencySymbol = currencyAttr || this.currencySymbolValue || "$";
      const newPeriodValue = periodAttr || newPeriod;

      this.sankeyDataValue = newSankeyData;
      this.currencySymbolValue = newCurrencySymbol;
      this.periodValue = newPeriodValue;

      const setBothAttrs = (base, value) => {
        const strValue = typeof value === "string" ? value : JSON.stringify(value);
        this.element.setAttribute(`data-cashflow-fullscreen-enhanced-${base}-value`, strValue);
        this.element.setAttribute(`data-cashflow-fullscreen-${base}-value`, strValue);
      };
      setBothAttrs("sankey-data", newSankeyData);
      setBothAttrs("currency-symbol", newCurrencySymbol);
      setBothAttrs("period", newPeriodValue);

      if (wasFullscreen) this.updateFullscreenContent();
      this.updateMainPageChart();

      window.history.pushState({}, "", url.toString());
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("Failed to update cashflow data:", error);
        this.showErrorOverlay("Failed to load data.");
      }
    } finally {
      if (wasFullscreen) this.hideBasicLoading();
      this.currentRequest = null;
    }
  }

  // Create fullscreen modal with React components
  createFullscreenModal() {
    this.fullscreenModal = document.createElement("div");
    this.fullscreenModal.className = `
      fixed inset-0 bg-black/50 backdrop-blur-sm z-50 opacity-0 transition-opacity duration-300
      flex flex-col
    `;

    const periodOptionsMarkup = this._buildPeriodOptionsMarkup();
    this.fullscreenModal.innerHTML = `
      <div class="flex-1 flex flex-col bg-container text-primary min-h-0">
        <!-- Header -->
        <div class="flex items-center justify-between p-6 border-b border-secondary bg-container">
          <div class="flex items-center gap-4">
            <h1 class="text-xl font-semibold">Cashflow Analysis</h1>
            <div class="flex items-center gap-2">
              <select 
                id="fullscreen-period-selector"
                class="bg-container border border-secondary font-medium rounded-lg px-3 py-2 text-sm pr-7 cursor-pointer text-primary focus:outline-hidden focus:ring-0">
                ${periodOptionsMarkup}
              </select>
            </div>
          </div>
          
          <div class="flex items-center gap-3">
            <button
              id="fullscreen-export-btn"
              class="flex items-center justify-center w-10 h-10 rounded-lg border border-secondary bg-container hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200 group focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
              title="Export chart as SVG"
              type="button"
              aria-label="Export chart as SVG">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </button>
            
            <button
              id="fullscreen-close-btn"
              class="flex items-center justify-center w-10 h-10 rounded-lg border border-secondary bg-container hover:bg-red-50 dark:hover:bg-red-900 text-gray-600 dark:text-gray-300 hover:text-red-600 dark:hover:text-red-400 transition-colors duration-200 group focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
              title="Exit fullscreen view"
              type="button"
              aria-label="Exit fullscreen view">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        </div>
        
        <!-- Main Chart Container -->
        <div class="flex-1 bg-gray-50 dark:bg-gray-800 min-h-0 p-6">
          <div class="h-full bg-container rounded-xl shadow-sm border border-secondary overflow-hidden relative">
            <div 
              id="fullscreen-sankey-container"
              class="w-full h-full p-4"
              data-controller="sankey-autosizer"
              data-sankey-autosizer-min-width-value="600"
              data-sankey-autosizer-min-height-value="400"
              data-sankey-autosizer-debounce-ms-value="100"
              style="min-height: 400px;">
              <div
                data-controller="sankey-chart"
                data-sankey-autosizer-target="chart"
                data-sankey-chart-data-value='${JSON.stringify(this.sankeyDataValue)}'
                data-sankey-chart-currency-symbol-value="${this.currencySymbolValue}"
                class="w-full h-full">
              </div>
            </div>
            
            <!-- Loading overlay container -->
            <div id="fullscreen-loading-overlay" class="hidden absolute inset-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm z-10 flex items-center justify-center pointer-events-none">
              <div class="flex flex-col items-center gap-3">
                <div class="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <span class="text-sm font-medium text-gray-600 dark:text-gray-300">Loading...</span>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Footer with Stats -->
        <div class="bg-container border-t border-secondary px-6 py-3">
          <div class="flex items-center justify-between text-sm text-secondary">
            <div class="flex items-center gap-6" id="fullscreen-stats">
              <span>Total Income: <strong class="text-primary">${this.formatCurrency(this.getTotalIncome())}</strong></span>
              <span>Total Expenses: <strong class="text-primary">${this.formatCurrency(this.getTotalExpenses())}</strong></span>
              <span>Net Flow: <strong class="text-primary ${this.getNetFlow() >= 0 ? "text-green-600" : "text-red-600"}">${this.formatCurrency(this.getNetFlow())}</strong></span>
            </div>
            <div class="text-xs text-secondary">
              Last updated: ${new Date().toLocaleDateString()}
            </div>
          </div>
        </div>
      </div>
    `;

    this.addModalEventListeners();
  }

  // Add event listeners to modal elements
  addModalEventListeners() {
    const closeBtn = this.fullscreenModal?.querySelector("#fullscreen-close-btn");
    const exportBtn = this.fullscreenModal?.querySelector("#fullscreen-export-btn");
    const periodSelector = this.fullscreenModal?.querySelector("#fullscreen-period-selector");

    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.exitFullscreen());
      closeBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.exitFullscreen();
        }
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener("click", () => this.handleExport());
      exportBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.handleExport();
        }
      });
    }

    if (periodSelector) {
      periodSelector.value = this.periodValue;
      periodSelector.addEventListener("change", (e) => {
        this.handlePeriodChangeDebounced(e.target.value);
      });
    }
  }

  // Fullscreen toggles
  // Handle keyboard events for accessibility
  handleKeydown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.toggleFullscreen();
    }
  }

  // Update aria-pressed attribute
  updateAriaPressed() {
    const isOpen = this.isFullscreenOpen();
    this.element?.setAttribute("aria-pressed", String(!!isOpen));
  }

  toggleFullscreen() {
    // Debounce rapid clicks
    const now = Date.now();
    if (now - this.lastClickTime < this.debounceDelay) {
      return;
    }
    this.lastClickTime = now;

    if (this.isFullscreenOpen()) {
      this.exitFullscreen();
    } else {
      this.enterFullscreen();
    }

    // Update aria-pressed state
    this.updateAriaPressed();
  }

  enterFullscreen() {
    if (this.isFullscreenOpen()) return;

    // Build modal
    this.createFullscreenModal();

    // Preserve focus and lock scroll
    this.prevActiveElement = document.activeElement;
    this.prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Mount modal
    document.body.appendChild(this.fullscreenModal);

    // Animate in
    requestAnimationFrame(() => {
      this.fullscreenModal.classList.remove("opacity-0");

      // Focus the close button for keyboard navigation
      const closeButton = this.fullscreenModal.querySelector("#fullscreen-close-btn");
      if (closeButton) {
        closeButton.focus();
      }
    });

    // Escape key listener
    document.addEventListener("keydown", this.escapeHandler);

    // Initialize chart + overlays
    this.initializeFullscreenChart();
    this.forceFullscreenResize();

    if (this.stateMachine?.is("loading")) {
      this.showLoadingOverlay("Updating cashflow data...");
    } else {
      this.clearFullscreenOverlays();
    }

    // Update footer stats
    this.updateFooterStats();
  }

  exitFullscreen() {
    if (!this.isFullscreenOpen()) return;

    // Animate out
    this.fullscreenModal.classList.add("opacity-0");

    // Cleanup listeners
    document.removeEventListener("keydown", this.escapeHandler);

    // Unmount React roots
    if (this.reactRoots) {
      this.reactRoots.forEach((root) => {
        try {
          root.unmount();
        } catch (_) {}
      });
      this.reactRoots.clear();
    }

    // Remove after animation
    setTimeout(() => {
      try {
        this.fullscreenModal?.remove();
      } finally {
        this.fullscreenModal = null;
        // Restore scroll
        document.body.style.overflow = this.prevBodyOverflow || "";
        // Restore focus
        if (this.prevActiveElement && typeof this.prevActiveElement.focus === "function") {
          this.prevActiveElement.focus();
        }
      }
    }, 250);
  }

  // Basic loading display
  showBasicLoading() {
    const overlay = this.fullscreenModal?.querySelector("#fullscreen-loading-overlay");
    if (overlay) {
      overlay.classList.remove("hidden");
    }
  }

  // Hide loading display
  hideBasicLoading() {
    const overlay = this.fullscreenModal?.querySelector("#fullscreen-loading-overlay");
    if (overlay) {
      overlay.classList.add("hidden");
    }
  }

  // Compatibility helpers for planned overlay API
  showLoadingOverlay(_message) {
    this.showBasicLoading();
  }

  clearFullscreenOverlays() {
    this.hideBasicLoading();
  }

  // Initialize fullscreen chart
  initializeFullscreenChart() {
    const container = this.fullscreenModal?.querySelector("#fullscreen-sankey-container");
    if (!container) return;

    // The sankey-autosizer and sankey-chart controllers will handle the rest
    // We just need to ensure the data attributes are up to date
    const chartElement = container.querySelector('[data-controller="sankey-chart"]');
    if (chartElement) {
      chartElement.setAttribute(
        "data-sankey-chart-data-value",
        JSON.stringify(this.sankeyDataValue)
      );
      chartElement.setAttribute(
        "data-sankey-chart-currency-symbol-value",
        this.currencySymbolValue
      );
      // Trigger a redraw if the controller is connected
      const controller = this.application?.getControllerForElementAndIdentifier(
        chartElement,
        "sankey-chart"
      );
      if (controller && typeof controller.dataValueChanged === "function") {
        controller.dataValueChanged();
      }
    }
  }

  // Update fullscreen content after data changes
  updateFullscreenContent() {
    this.initializeFullscreenChart();

    // Update period selector
    const periodSelector = this.fullscreenModal?.querySelector("#fullscreen-period-selector");
    if (periodSelector) {
      periodSelector.value = this.periodValue;
    }

    // Update footer stats
    this.updateFooterStats();

    // Hide any loading states
    this.hideBasicLoading();
  }

  // Update main page chart
  updateMainPageChart() {
    const candidates = document.querySelectorAll('[data-controller="sankey-chart"]');
    let mainChartElement = null;

    for (const el of candidates) {
      if (!el.closest("#fullscreen-sankey-container")) {
        mainChartElement = el;
        break;
      }
    }

    if (mainChartElement) {
      mainChartElement.setAttribute(
        "data-sankey-chart-data-value",
        JSON.stringify(this.sankeyDataValue)
      );
      mainChartElement.setAttribute(
        "data-sankey-chart-currency-symbol-value",
        this.currencySymbolValue
      );

      // Trigger dataValueChanged if the controller exists
      const controller = this.application?.getControllerForElementAndIdentifier(
        mainChartElement,
        "sankey-chart"
      );
      if (controller && typeof controller.dataValueChanged === "function") {
        controller.dataValueChanged();
      }
    }
  }

  // Force fullscreen resize
  forceFullscreenResize() {
    const autosizerContainer = this.fullscreenModal?.querySelector("#fullscreen-sankey-container");
    if (autosizerContainer) {
      const autosizerController = this.application?.getControllerForElementAndIdentifier(
        autosizerContainer,
        "sankey-autosizer"
      );

      if (autosizerController && typeof autosizerController.forceResize === "function") {
        autosizerController.forceResize();
      }
    }
  }

  // Update footer stats
  updateFooterStats() {
    const statsContainer = this.fullscreenModal?.querySelector("#fullscreen-stats");
    if (statsContainer) {
      statsContainer.innerHTML = `
        <span>Total Income: <strong class="text-primary">${this.formatCurrency(this.getTotalIncome())}</strong></span>
        <span>Total Expenses: <strong class="text-primary">${this.formatCurrency(this.getTotalExpenses())}</strong></span>
        <span>Net Flow: <strong class="text-primary ${this.getNetFlow() >= 0 ? "text-green-600" : "text-red-600"}">${this.formatCurrency(this.getNetFlow())}</strong></span>
      `;
    }
  }

  // Handle escape key
  handleEscape(event) {
    if (event.key === "Escape" && this.isFullscreenOpen()) {
      event.preventDefault();
      this.exitFullscreen();
    }
  }

  // Handle export
  async handleExport() {
    try {
      const svg = this.fullscreenModal?.querySelector("#fullscreen-sankey-container svg");
      if (!svg) {
        this.showErrorOverlay("Chart not ready to export yet.");
        return;
      }

      const clone = svg.cloneNode(true);
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(clone);
      const blob = new Blob([svgString], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);

      const link = document.createElement("a");
      const fileName = `cashflow_sankey_${this.periodValue}_${new Date().toISOString().slice(0, 10)}.svg`;
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export failed:", e);
      this.showErrorOverlay("Failed to export chart.");
    }
  }

  // Display an error overlay inside the fullscreen modal
  showErrorOverlay(message) {
    const overlay = this.fullscreenModal?.querySelector("#fullscreen-loading-overlay");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    overlay.innerHTML = `
      <div class="flex flex-col items-center gap-3 text-red-600 dark:text-red-400">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"/>
        </svg>
        <span class="text-sm font-medium">${message}</span>
      </div>
    `;
  }

  // Build period options markup using shared options from Rails (Period.as_options)
  _buildPeriodOptionsMarkup() {
    const opts = Array.isArray(this.periodOptionsValue) ? this.periodOptionsValue : [];
    const options =
      opts.length > 0
        ? opts
        : [
            ["1D", "last_day"],
            ["WTD", "current_week"],
            ["7D", "last_7_days"],
            ["MTD", "current_month"],
            ["30D", "last_30_days"],
            ["90D", "last_90_days"],
            ["YTD", "current_year"],
            ["365D", "last_365_days"],
            ["5Y", "last_5_years"],
          ];

    return options
      .map(
        ([label, key]) =>
          `<option value="${key}" ${key === this.periodValue ? "selected" : ""}>${label}</option>`
      )
      .join("");
  }

  // Utility methods
  isFullscreenOpen() {
    return !!(this.fullscreenModal && document.body.contains(this.fullscreenModal));
  }

  getTotalIncome() {
    if (!this.sankeyDataValue?.links) return 0;

    const cashFlowNodeIndex = this.sankeyDataValue.nodes.findIndex(
      (node) => node.name === "Cash Flow"
    );
    if (cashFlowNodeIndex === -1) return 0;

    return this.sankeyDataValue.links
      .filter((link) => link.target === cashFlowNodeIndex)
      .reduce((sum, link) => sum + (Number.parseFloat(link.value) || 0), 0);
  }

  getTotalExpenses() {
    if (!this.sankeyDataValue?.links) return 0;

    const cashFlowNodeIndex = this.sankeyDataValue.nodes.findIndex(
      (node) => node.name === "Cash Flow"
    );
    if (cashFlowNodeIndex === -1) return 0;

    return this.sankeyDataValue.links
      .filter((link) => link.source === cashFlowNodeIndex)
      .filter((link) => {
        const targetNode = this.sankeyDataValue.nodes[link.target];
        return targetNode && targetNode.name !== "Surplus";
      })
      .reduce((sum, link) => sum + (Number.parseFloat(link.value) || 0), 0);
  }

  getNetFlow() {
    return this.getTotalIncome() - this.getTotalExpenses();
  }

  formatCurrency(amount) {
    return (
      this.currencySymbolValue +
      Math.abs(amount).toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })
    );
  }

  // Basic cleanup method
  cleanup() {
    this.isUnmounted = true;

    // Clear timers and requests
    this.clearWatchdogTimer();
    if (this.currentRequest) {
      this.currentRequest.abort();
      this.currentRequest = null;
    }

    // Clean up fullscreen modal
    if (this.isFullscreenOpen()) {
      this.exitFullscreen();
    }

    // Remove event listeners
    document.removeEventListener("keydown", this.escapeHandler);
  }
}
