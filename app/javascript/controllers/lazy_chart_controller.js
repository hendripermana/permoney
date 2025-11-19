import { Controller } from "@hotwired/stimulus";

/**
 * Lazy Chart Controller
 *
 * Implements Intersection Observer API for lazy loading heavy D3 charts
 * Only loads and renders charts when they enter the viewport
 *
 * Usage:
 *   <div data-controller="lazy-chart"
 *        data-lazy-chart-threshold-value="0.1"
 *        data-lazy-chart-chart-type-value="sankey"
 *        data-lazy-chart-data-value="<%= @chart_data.to_json %>">
 *     <div class="animate-pulse bg-surface-inset h-64 rounded-xl"></div>
 *   </div>
 */
export default class extends Controller {
  static values = {
    threshold: { type: Number, default: 0.1 },
    chartType: String,
    data: Object,
  };

  connect() {
    // Create Intersection Observer for lazy loading
    this.observer = new IntersectionObserver((entries) => this.handleIntersection(entries), {
      root: null, // viewport
      rootMargin: "50px", // Load 50px before entering viewport
      threshold: this.thresholdValue,
    });

    // Start observing the element
    this.observer.observe(this.element);
  }

  disconnect() {
    // Clean up observer when controller disconnects
    if (this.observer) {
      this.observer.disconnect();
    }
  }

  async handleIntersection(entries) {
    const entry = entries[0];

    if (entry.isIntersecting && !this.loaded) {
      this.loaded = true;
      this.observer.disconnect(); // Stop observing after load

      try {
        await this.loadChart();
      } catch (error) {
        console.error("Failed to load chart:", error);
        this.showError();
      }
    }
  }

  async loadChart() {
    // Show loading state
    this.element.innerHTML = `
      <div class="flex items-center justify-center h-64">
        <div class="text-secondary text-sm">Loading chart...</div>
      </div>
    `;

    // Dynamically import D3 only when needed
    const chartType = this.chartTypeValue;

    switch (chartType) {
      case "sankey":
        await this.loadSankeyChart();
        break;
      case "area":
        await this.loadAreaChart();
        break;
      case "line":
        await this.loadLineChart();
        break;
      default:
        console.warn(`Unknown chart type: ${chartType}`);
    }
  }

  async loadSankeyChart() {
    // Dynamic import - only loads when needed
    const [d3, { sankey, sankeyLinkHorizontal }] = await Promise.all([
      import("d3"),
      import("d3-sankey"),
    ]);

    // Trigger custom event to initialize Sankey chart
    // The sankey controller will handle the actual rendering
    this.element.dispatchEvent(
      new CustomEvent("lazy-chart:loaded", {
        bubbles: true,
        detail: { chartType: "sankey", d3, sankey, sankeyLinkHorizontal },
      })
    );
  }

  async loadAreaChart() {
    const d3 = await import("d3");

    this.element.dispatchEvent(
      new CustomEvent("lazy-chart:loaded", {
        bubbles: true,
        detail: { chartType: "area", d3 },
      })
    );
  }

  async loadLineChart() {
    const d3 = await import("d3");

    this.element.dispatchEvent(
      new CustomEvent("lazy-chart:loaded", {
        bubbles: true,
        detail: { chartType: "line", d3 },
      })
    );
  }

  showError() {
    this.element.innerHTML = `
      <div class="flex items-center justify-center h-64 text-danger">
        <div class="text-center">
          <p class="text-sm">Failed to load chart</p>
          <button 
            class="text-link text-sm underline mt-2"
            data-action="click->lazy-chart#retry">
            Retry
          </button>
        </div>
      </div>
    `;
  }

  retry() {
    // Rails 8.1: Recreate observer instead of reusing disconnected one
    // Disconnected observers cannot be re-observed, so we need to create a new one
    this.loaded = false;

    // Disconnect old observer if it exists
    if (this.observer) {
      this.observer.disconnect();
    }

    // Create new observer
    this.observer = new IntersectionObserver((entries) => this.handleIntersection(entries), {
      root: null,
      rootMargin: "50px",
      threshold: this.thresholdValue,
    });

    // Start observing
    this.observer.observe(this.element);
  }
}
