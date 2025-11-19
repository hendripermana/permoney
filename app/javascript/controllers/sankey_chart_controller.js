import { Controller } from "@hotwired/stimulus";
import * as d3 from "d3";
import { sankey } from "d3-sankey";

// Connects to data-controller="sankey-chart"
export default class extends Controller {
  static values = {
    data: Object,
    nodeWidth: { type: Number, default: 15 },
    nodePadding: { type: Number, default: 20 },
    currencySymbol: { type: String, default: "$" },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
  };

  // Handle resize events from SankeyAutoSizer
  handleExternalResize(event) {
    const { width, height } = event.detail;
    this.updateDimensions({ width, height });
  }

  // Public API method for updating dimensions
  updateDimensions(dimensions) {
    this.currentDimensions = dimensions;
    this.#draw();
  }

  // Get effective dimensions (from props, autosizer, or container)
  #getEffectiveDimensions() {
    // Priority: explicit width/height values > autosizer dimensions > container measurement
    if (this.widthValue && this.heightValue) {
      return { width: this.widthValue, height: this.heightValue };
    }

    if (this.currentDimensions) {
      return this.currentDimensions;
    }

    // Fallback to measuring container
    const containerRect = this.element.getBoundingClientRect();
    const computedStyle = window.getComputedStyle(this.element);

    const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
    const paddingLeft = Number.parseFloat(computedStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(computedStyle.paddingRight) || 0;

    const borderTop = Number.parseFloat(computedStyle.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(computedStyle.borderBottomWidth) || 0;
    const borderLeft = Number.parseFloat(computedStyle.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(computedStyle.borderRightWidth) || 0;

    const availableWidth =
      containerRect.width - paddingLeft - paddingRight - borderLeft - borderRight;
    const availableHeight =
      containerRect.height - paddingTop - paddingBottom - borderTop - borderBottom;

    return {
      width: Math.max(320, availableWidth),
      height: Math.max(220, availableHeight),
    };
  }

  // Calculate dynamic padding based on container size (4% of min dimension)
  #calculateDynamicPadding(width, height) {
    const minDimension = Math.min(width, height);
    const basePadding = Math.max(20, minDimension * 0.04); // 4% of min dimension, min 20px

    return {
      top: Math.max(25, basePadding),
      right: Math.max(60, basePadding * 2), // More space for labels
      bottom: Math.max(25, basePadding),
      left: Math.max(60, basePadding * 2), // More space for labels
    };
  }

  // Calculate responsive node dimensions
  #calculateNodeDimensions(width, height) {
    return {
      nodeWidth: Math.max(8, Math.min(this.nodeWidthValue, width * 0.025)),
      nodePadding: Math.max(8, Math.min(this.nodePaddingValue, height * 0.04)),
    };
  }

  // Calculate responsive font sizes
  #calculateFontSizes(width) {
    return {
      labelFontSize: Math.max(10, Math.min(14, width * 0.022)),
      valueFontSize: Math.max(9, Math.min(12, width * 0.018)),
    };
  }

  connect() {
    this.tooltip = null;
    this.#createTooltip();
    this.currentDimensions = null;
    this.lastDataHash = null;

    // Listen for resize events from SankeyAutoSizer
    this.element.addEventListener("sankey:resize", this.handleExternalResize.bind(this));

    // Initial draw with a slight delay to ensure container is properly sized
    requestAnimationFrame(() => {
      this.#draw();
    });
  }

  // Handle data value changes (called by Stimulus when data-value changes)
  dataValueChanged() {
    // Only redraw if data actually changed to prevent unnecessary renders
    const currentDataHash = this.#hashData(this.dataValue);
    if (currentDataHash !== this.lastDataHash) {
      this.lastDataHash = currentDataHash;
      this.#draw();
    }
  }

  // Generate a simple hash of the data to detect changes
  #hashData(data) {
    if (!data) return null;
    try {
      return JSON.stringify(data);
    } catch (error) {
      console.warn("Failed to hash sankey data:", error);
      return Math.random().toString(); // Force redraw on error
    }
  }

  disconnect() {
    // Clean up event listeners
    this.element.removeEventListener("sankey:resize", this.handleExternalResize.bind(this));

    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }
  }

  #draw() {
    const { nodes = [], links = [] } = this.dataValue || {};

    if (!nodes.length || !links.length) return;

    // Constants
    const HOVER_OPACITY = 0.4;
    const HOVER_FILTER = "saturate(1.3) brightness(1.1)";

    // Hover utility functions
    const applyHoverEffect = (targetLinks, allLinks, allNodes) => {
      const targetLinksSet = new Set(targetLinks);
      allLinks
        .style("opacity", (linkData) => (targetLinksSet.has(linkData) ? 1 : HOVER_OPACITY))
        .style("filter", (linkData) => (targetLinksSet.has(linkData) ? HOVER_FILTER : "none"));

      const connectedNodes = new Set();
      targetLinks.forEach((link) => {
        connectedNodes.add(link.source);
        connectedNodes.add(link.target);
      });

      allNodes.style("opacity", (nodeData) => (connectedNodes.has(nodeData) ? 1 : HOVER_OPACITY));
    };

    const resetHoverEffect = (allLinks, allNodes) => {
      allLinks.style("opacity", 1).style("filter", "none");
      allNodes.style("opacity", 1);
    };

    // Clear previous SVG
    d3.select(this.element).selectAll("svg").remove();

    // Get effective dimensions using new responsive system
    const { width, height } = this.#getEffectiveDimensions();

    // Calculate dynamic spacing and sizing
    const margin = this.#calculateDynamicPadding(width, height);
    const { nodeWidth, nodePadding } = this.#calculateNodeDimensions(width, height);
    const { labelFontSize, valueFontSize } = this.#calculateFontSizes(width);

    // Create responsive SVG that shows all content without cutoff
    const svg = d3
      .select(this.element)
      .append("svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("preserveAspectRatio", "xMidYMid meet") // Changed back to meet to prevent cutoff
      .style("background", "transparent")
      .style("display", "block") // Ensure no inline spacing issues
      .style("max-width", "100%")
      .style("max-height", "100%");

    // Use dynamic margins calculated above
    const _sankeyWidth = width - margin.left - margin.right;
    const _sankeyHeight = height - margin.top - margin.bottom;

    // Ensure the Sankey uses the available space while preventing text cutoff
    const sankeyGenerator = sankey()
      .nodeWidth(nodeWidth)
      .nodePadding(nodePadding)
      .extent([
        [margin.left, margin.top],
        [width - margin.right, height - margin.bottom],
      ]);

    const sankeyData = sankeyGenerator({
      nodes: nodes.map((d) => Object.assign({}, d)),
      links: links.map((d) => Object.assign({}, d)),
    });

    // Define gradients for links
    const defs = svg.append("defs");

    sankeyData.links.forEach((link, i) => {
      const gradientId = `link-gradient-${link.source.index}-${link.target.index}-${i}`;

      const getStopColorWithOpacity = (nodeColorInput, opacity = 0.1) => {
        let colorStr = nodeColorInput || "var(--color-gray-400)";
        if (colorStr === "var(--color-success)") {
          colorStr = "#10A861"; // Hex for --color-green-600
        }
        // Add other CSS var to hex mappings here if needed

        if (colorStr.startsWith("var(--")) {
          // Unmapped CSS var, use as is (likely solid)
          return colorStr;
        }

        const d3Color = d3.color(colorStr);
        return d3Color ? d3Color.copy({ opacity: opacity }) : "var(--color-gray-400)";
      };

      const sourceStopColor = getStopColorWithOpacity(link.source.color);
      const targetStopColor = getStopColorWithOpacity(link.target.color);

      const gradient = defs
        .append("linearGradient")
        .attr("id", gradientId)
        .attr("gradientUnits", "userSpaceOnUse")
        .attr("x1", link.source.x1)
        .attr("x2", link.target.x0);

      gradient.append("stop").attr("offset", "0%").attr("stop-color", sourceStopColor);

      gradient.append("stop").attr("offset", "100%").attr("stop-color", targetStopColor);
    });

    // Draw links
    const linksContainer = svg.append("g").attr("fill", "none");

    const linkPaths = linksContainer
      .selectAll("path")
      .data(sankeyData.links)
      .join("path")
      .attr("class", "sankey-link")
      .attr("d", (d) => {
        const sourceX = d.source.x1;
        const targetX = d.target.x0;
        const path = d3.linkHorizontal()({
          source: [sourceX, d.y0],
          target: [targetX, d.y1],
        });
        return path;
      })
      .attr("stroke", (d, i) => `url(#link-gradient-${d.source.index}-${d.target.index}-${i})`)
      .attr("stroke-width", (d) => Math.max(1, d.width))
      .style("transition", "opacity 0.3s ease");

    // Draw nodes
    const nodeGroups = svg
      .append("g")
      .selectAll("g")
      .data(sankeyData.nodes)
      .join("g")
      .style("transition", "opacity 0.3s ease");

    const cornerRadius = 8;

    nodeGroups
      .append("path")
      .attr("d", (d) => {
        const x0 = d.x0;
        const y0 = d.y0;
        const x1 = d.x1;
        const y1 = d.y1;
        const h = y1 - y0;
        // const w = x1 - x0; // Not directly used in path string, but good for context

        // Dynamic corner radius based on node height, maxed at 8
        const effectiveCornerRadius = Math.max(0, Math.min(cornerRadius, h / 2));

        const isSourceNode =
          d.sourceLinks &&
          d.sourceLinks.length > 0 &&
          (!d.targetLinks || d.targetLinks.length === 0);
        const isTargetNode =
          d.targetLinks &&
          d.targetLinks.length > 0 &&
          (!d.sourceLinks || d.sourceLinks.length === 0);

        if (isSourceNode) {
          // Round left corners, flat right for "Total Income"
          if (h < effectiveCornerRadius * 2) {
            return `M ${x0},${y0} L ${x1},${y0} L ${x1},${y1} L ${x0},${y1} Z`;
          }
          return `M ${x0 + effectiveCornerRadius},${y0}
                  L ${x1},${y0}
                  L ${x1},${y1}
                  L ${x0 + effectiveCornerRadius},${y1}
                  Q ${x0},${y1} ${x0},${y1 - effectiveCornerRadius}
                  L ${x0},${y0 + effectiveCornerRadius}
                  Q ${x0},${y0} ${x0 + effectiveCornerRadius},${y0} Z`;
        }

        if (isTargetNode) {
          // Flat left corners, round right for Categories/Surplus
          if (h < effectiveCornerRadius * 2) {
            return `M ${x0},${y0} L ${x1},${y0} L ${x1},${y1} L ${x0},${y1} Z`;
          }
          return `M ${x0},${y0}
                  L ${x1 - effectiveCornerRadius},${y0}
                  Q ${x1},${y0} ${x1},${y0 + effectiveCornerRadius}
                  L ${x1},${y1 - effectiveCornerRadius}
                  Q ${x1},${y1} ${x1 - effectiveCornerRadius},${y1}
                  L ${x0},${y1} Z`;
        }

        // Fallback for intermediate nodes (e.g., "Cash Flow") - draw as a simple sharp-cornered rectangle
        return `M ${x0},${y0} L ${x1},${y0} L ${x1},${y1} L ${x0},${y1} Z`;
      })
      .attr("fill", (d) => d.color || "var(--color-gray-400)")
      .attr("stroke", (d) => {
        // If a node has an explicit color assigned (even if it's a gray variable),
        // it gets no stroke. Only truly un-colored nodes (falling back to default fill)
        // would get a stroke, but our current data structure assigns colors to all nodes.
        if (d.color) {
          return "none";
        }
        return "var(--color-gray-500)"; // Fallback, likely unused with current data
      });

    // Add hover events to links after creating nodes
    linkPaths
      .on("mouseenter", (event, d) => {
        applyHoverEffect([d], linkPaths, nodeGroups);
        this.#showTooltip(event, d);
      })
      .on("mousemove", (event) => this.#updateTooltipPosition(event))
      .on("mouseleave", () => {
        resetHoverEffect(linkPaths, nodeGroups);
        this.#hideTooltip();
      });

    const stimulusControllerInstance = this;
    nodeGroups
      .append("text")
      .attr("x", (d) => {
        // Enhanced positioning with responsive offset
        const baseOffset = Math.max(8, width * 0.015); // Responsive offset
        return d.x0 < width / 2 ? d.x1 + baseOffset : d.x0 - baseOffset;
      })
      .attr("y", (d) => (d.y1 + d.y0) / 2)
      .attr("dy", "-0.2em")
      .attr("text-anchor", (d) => (d.x0 < width / 2 ? "start" : "end"))
      .attr("class", "font-medium text-primary fill-current select-none")
      .style("font-size", `${labelFontSize}px`)
      .style("cursor", "default")
      .on("mouseenter", (event, d) => {
        // Find all links connected to this node
        const connectedLinks = sankeyData.links.filter(
          (link) => link.source === d || link.target === d
        );

        applyHoverEffect(connectedLinks, linkPaths, nodeGroups);
        this.#showNodeTooltip(event, d);
      })
      .on("mousemove", (event) => this.#updateTooltipPosition(event))
      .on("mouseleave", () => {
        resetHoverEffect(linkPaths, nodeGroups);
        this.#hideTooltip();
      })
      .each(function (d) {
        const textElement = d3.select(this);
        textElement.selectAll("tspan").remove();

        // Dynamic text handling based on available space
        const maxTextWidth = Math.min(150, width * 0.25);
        const _isLeftSide = d.x0 < width / 2;

        // Smart text truncation based on available space
        const maxChars = Math.max(
          8,
          Math.min(20, Math.floor(maxTextWidth / (labelFontSize * 0.6)))
        );
        let displayName = d.name;
        let isNameTruncated = false;

        if (displayName.length > maxChars) {
          displayName = `${displayName.substring(0, maxChars - 3)}...`;
          isNameTruncated = true;
        }

        const nameSpan = textElement.append("tspan").text(displayName).attr("font-weight", "500");

        // Add tooltip for truncated names
        if (isNameTruncated) {
          nameSpan.attr("title", d.name);
        }

        // Financial details on the second line with responsive sizing
        const financialDetailsTspan = textElement
          .append("tspan")
          .attr("x", textElement.attr("x"))
          .attr("dy", "1.3em")
          .attr("class", "font-mono text-secondary")
          .style("font-size", `${valueFontSize}px`);

        const formattedValue =
          stimulusControllerInstance.currencySymbolValue +
          Number.parseFloat(d.value).toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          });

        financialDetailsTspan.append("tspan").text(formattedValue);
      });
  }

  #createTooltip() {
    // Create tooltip element once and reuse it
    this.tooltip = d3
      .select("body")
      .append("div")
      .attr("class", "bg-gray-700 text-white text-sm p-2 rounded pointer-events-none absolute z-50")
      .style("opacity", 0)
      .style("pointer-events", "none");
  }

  #showTooltip(event, linkData) {
    this.#displayTooltip(event, linkData.value, linkData.percentage);
  }

  #showNodeTooltip(event, nodeData) {
    this.#displayTooltip(event, nodeData.value, nodeData.percentage, nodeData.name);
  }

  #displayTooltip(event, value, percentage, title = null) {
    if (!this.tooltip) {
      this.#createTooltip();
    }

    // Format the tooltip content
    const formattedValue =
      this.currencySymbolValue +
      Number.parseFloat(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    const percentageText = percentage ? `${percentage}%` : "0%";

    const content = title
      ? `${title}<br/>${formattedValue} (${percentageText})`
      : `${formattedValue} (${percentageText})`;

    this.tooltip
      .html(content)
      .style("left", `${event.pageX + 10}px`)
      .style("top", `${event.pageY - 10}px`)
      .transition()
      .duration(100)
      .style("opacity", 1);
  }

  #updateTooltipPosition(event) {
    if (this.tooltip) {
      this.tooltip.style("left", `${event.pageX + 10}px`).style("top", `${event.pageY - 10}px`);
    }
  }

  #hideTooltip() {
    if (this.tooltip) {
      this.tooltip.transition().duration(100).style("opacity", 0);
    }
  }
}
