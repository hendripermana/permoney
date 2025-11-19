import { Controller } from "@hotwired/stimulus";
import { useResizeObserver } from "lib/ui/useResizeObserver";

/**
 * SankeyAutoSizer Controller
 *
 * Provides automatic sizing for Sankey charts using ResizeObserver.
 * Measures the parent container and passes dimensions to child chart components.
 *
 * Usage:
 * <div data-controller="sankey-autosizer"
 *      data-sankey-autosizer-min-width-value="320"
 *      data-sankey-autosizer-min-height-value="220"
 *      data-sankey-autosizer-max-width-value="1200"
 *      data-sankey-autosizer-max-height-value="800">
 *   <div data-controller="sankey-chart"
 *        data-sankey-autosizer-target="chart"
 *        data-sankey-chart-data-value="{...}">
 *   </div>
 * </div>
 */
export default class extends Controller {
  static values = {
    minWidth: { type: Number, default: 320 },
    minHeight: { type: Number, default: 220 },
    maxWidth: { type: Number, default: Number.POSITIVE_INFINITY },
    maxHeight: { type: Number, default: Number.POSITIVE_INFINITY },
    aspectRatio: { type: Number, default: null }, // Optional aspect ratio constraint
    debounceMs: { type: Number, default: 100 },
  };

  static targets = ["chart"];

  connect() {
    this.resizeCleanup = null;
    this.currentDimensions = null;
    this.isInitialized = false;

    // Initialize resize observation
    this.initializeResizeObserver();
  }

  disconnect() {
    this.cleanup();
  }

  initializeResizeObserver() {
    // SSR-safe initial dimensions
    const initialSize = {
      width: Math.max(this.minWidthValue, 800),
      height: Math.max(this.minHeightValue, 600),
    };

    // Set up resize observer with debouncing
    this.resizeCleanup = useResizeObserver(
      this.element,
      (dimensions) => this.handleResize(dimensions),
      {
        debounceMs: this.debounceMs,
        initialSize,
      }
    );
  }

  handleResize(rawDimensions) {
    const constrainedDimensions = this.constrainDimensions(rawDimensions);

    // Only update if dimensions actually changed
    if (this.dimensionsChanged(constrainedDimensions)) {
      this.currentDimensions = constrainedDimensions;
      this.updateChartDimensions(constrainedDimensions);

      // Dispatch custom event for other components to listen to
      this.dispatchResizeEvent(constrainedDimensions);
    }
  }

  constrainDimensions({ width, height }) {
    // Apply min/max constraints
    let constrainedWidth = Math.max(this.minWidthValue, Math.min(this.maxWidthValue, width));
    let constrainedHeight = Math.max(this.minHeightValue, Math.min(this.maxHeightValue, height));

    // Apply aspect ratio if specified
    if (this.aspectRatioValue) {
      const currentRatio = constrainedWidth / constrainedHeight;

      if (currentRatio > this.aspectRatioValue) {
        // Too wide, constrain width
        constrainedWidth = constrainedHeight * this.aspectRatioValue;
      } else if (currentRatio < this.aspectRatioValue) {
        // Too tall, constrain height
        constrainedHeight = constrainedWidth / this.aspectRatioValue;
      }
    }

    return {
      width: Math.round(constrainedWidth),
      height: Math.round(constrainedHeight),
    };
  }

  dimensionsChanged(newDimensions) {
    if (!this.currentDimensions) return true;

    return (
      this.currentDimensions.width !== newDimensions.width ||
      this.currentDimensions.height !== newDimensions.height
    );
  }

  updateChartDimensions(dimensions) {
    // Update all chart targets with new dimensions
    this.chartTargets.forEach((chartElement) => {
      this.updateSingleChart(chartElement, dimensions);
    });
  }

  updateSingleChart(chartElement, dimensions) {
    // If the chart element has a Stimulus controller, call its resize method
    const chartController = this.application.getControllerForElementAndIdentifier(
      chartElement,
      "sankey-chart"
    );

    if (chartController && typeof chartController.updateDimensions === "function") {
      chartController.updateDimensions(dimensions);
    } else if (chartController && typeof chartController.draw === "function") {
      // Fallback: trigger redraw if updateDimensions method doesn't exist
      chartController.draw();
    }

    // Also set CSS custom properties for styling purposes
    chartElement.style.setProperty("--chart-width", `${dimensions.width}px`);
    chartElement.style.setProperty("--chart-height", `${dimensions.height}px`);

    // Set data attributes for other components to read
    chartElement.dataset.chartWidth = dimensions.width.toString();
    chartElement.dataset.chartHeight = dimensions.height.toString();
  }

  dispatchResizeEvent(dimensions) {
    const event = new CustomEvent("sankey:resize", {
      detail: {
        width: dimensions.width,
        height: dimensions.height,
        element: this.element,
      },
      bubbles: true,
    });

    this.element.dispatchEvent(event);
  }

  // Public API methods

  /**
   * Get current dimensions
   */
  getDimensions() {
    return (
      this.currentDimensions || {
        width: this.minWidthValue,
        height: this.minHeightValue,
      }
    );
  }

  /**
   * Force a resize check
   */
  forceResize() {
    if (this.element) {
      const rect = this.element.getBoundingClientRect();
      this.handleResize({
        width: rect.width,
        height: rect.height,
      });
    }
  }

  /**
   * Update constraints dynamically
   */
  updateConstraints(constraints = {}) {
    if (constraints.minWidth !== undefined) this.minWidthValue = constraints.minWidth;
    if (constraints.minHeight !== undefined) this.minHeightValue = constraints.minHeight;
    if (constraints.maxWidth !== undefined) this.maxWidthValue = constraints.maxWidth;
    if (constraints.maxHeight !== undefined) this.maxHeightValue = constraints.maxHeight;
    if (constraints.aspectRatio !== undefined) this.aspectRatioValue = constraints.aspectRatio;

    // Trigger resize with new constraints
    this.forceResize();
  }

  cleanup() {
    if (this.resizeCleanup) {
      this.resizeCleanup();
      this.resizeCleanup = null;
    }

    this.currentDimensions = null;
  }

  // Value change callbacks
  minWidthValueChanged() {
    if (this.isInitialized) this.forceResize();
  }

  minHeightValueChanged() {
    if (this.isInitialized) this.forceResize();
  }

  maxWidthValueChanged() {
    if (this.isInitialized) this.forceResize();
  }

  maxHeightValueChanged() {
    if (this.isInitialized) this.forceResize();
  }

  aspectRatioValueChanged() {
    if (this.isInitialized) this.forceResize();
  }

  // Target callbacks
  chartTargetConnected(element) {
    // When a new chart target is connected, update it with current dimensions
    if (this.currentDimensions) {
      this.updateSingleChart(element, this.currentDimensions);
    }
  }

  chartTargetDisconnected(element) {
    // Clean up any chart-specific resources if needed
    element.style.removeProperty("--chart-width");
    element.style.removeProperty("--chart-height");
    delete element.dataset.chartWidth;
    delete element.dataset.chartHeight;
  }
}
