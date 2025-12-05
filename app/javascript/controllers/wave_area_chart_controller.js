import { Controller } from "@hotwired/stimulus";
import * as d3 from "d3";

const parseLocalDate = d3.timeParse("%Y-%m-%d");

export default class extends Controller {
  static values = {
    data: Object,
    strokeWidth: { type: Number, default: 2 },
    fillOpacity: { type: Number, default: 0.15 },
    gradientColor: String,
    useLabels: { type: Boolean, default: true },
    useTooltip: { type: Boolean, default: true },
    curveType: { type: String, default: "monotoneX" },
  };

  _d3SvgMemo = null;
  _d3GroupMemo = null;
  _d3Tooltip = null;
  _d3InitialContainerWidth = 0;
  _d3InitialContainerHeight = 0;
  _normalDataPoints = [];
  _resizeObserver = null;

  connect() {
    this._install();
    document.addEventListener("turbo:load", this._reinstall);
    this._setupResizeObserver();
  }

  disconnect() {
    this._teardown();
    document.removeEventListener("turbo:load", this._reinstall);
    this._resizeObserver?.disconnect();
  }

  _reinstall = () => {
    this._teardown();
    this._install();
  };

  _teardown() {
    this._d3SvgMemo = null;
    this._d3GroupMemo = null;
    this._d3Tooltip = null;
    this._normalDataPoints = [];

    this._d3Container.selectAll("*").remove();
  }

  _install() {
    this._normalizeDataPoints();
    this._rememberInitialContainerSize();
    this._draw();
  }

  _normalizeDataPoints() {
    this._normalDataPoints = (this.dataValue.values || []).map((d) => ({
      date: parseLocalDate(d.date),
      date_formatted: d.date_formatted,
      value: d.value,
      trend: d.trend,
    }));
  }

  _rememberInitialContainerSize() {
    this._d3InitialContainerWidth = this._d3Container.node().clientWidth;
    this._d3InitialContainerHeight = this._d3Container.node().clientHeight;
  }

  _draw() {
    if (this._normalDataPoints.length < 2) {
      this._drawEmpty();
    } else {
      this._drawChart();
    }
  }

  _drawEmpty() {
    this._d3Svg.selectAll(".tick").remove();
    this._d3Svg.selectAll(".domain").remove();

    this._d3Svg
      .append("text")
      .attr("x", this._d3InitialContainerWidth / 2)
      .attr("y", this._d3InitialContainerHeight / 2)
      .attr("text-anchor", "middle")
      .attr("class", "fg-subdued text-sm")
      .text("Not enough data");
  }

  _drawChart() {
    this._drawFilledArea();
    this._drawTrendline();

    if (this.useLabelsValue) {
      this._drawXAxisLabels();
    }

    if (this.useTooltipValue) {
      this._drawTooltip();
      this._trackMouseForShowingTooltip();
    }
  }

  _drawFilledArea() {
    const gradient = this._d3Group
      .append("defs")
      .append("linearGradient")
      .attr("id", `${this.element.id}-area-gradient`)
      .attr("gradientUnits", "userSpaceOnUse")
      .attr("x1", 0)
      .attr("x2", 0)
      .attr("y1", 0)
      .attr("y2", this._d3ContainerHeight);

    gradient
      .append("stop")
      .attr("offset", "0%")
      .attr("stop-color", this._gradientColor)
      .attr("stop-opacity", this.fillOpacityValue);

    gradient
      .append("stop")
      .attr("offset", "100%")
      .attr("stop-color", this._gradientColor)
      .attr("stop-opacity", 0);

    const area = d3
      .area()
      .x((d) => this._d3XScale(d.date))
      .y0(this._d3ContainerHeight)
      .y1((d) => this._d3YScale(this._getDatumValue(d)))
      .curve(this._curveFunction);

    this._d3Group
      .append("path")
      .datum(this._normalDataPoints)
      .attr("fill", `url(#${this.element.id}-area-gradient)`)
      .attr("d", area);
  }

  _drawTrendline() {
    this._d3Group
      .append("path")
      .datum(this._normalDataPoints)
      .attr("fill", "none")
      .attr("stroke", this._trendColor)
      .attr("d", this._d3Line)
      .attr("stroke-linejoin", "round")
      .attr("stroke-linecap", "round")
      .attr("stroke-width", this.strokeWidthValue);
  }

  _drawXAxisLabels() {
    this._d3Group
      .append("g")
      .attr("transform", `translate(0,${this._d3ContainerHeight})`)
      .call(
        d3
          .axisBottom(this._d3XScale)
          .tickValues(
            [
              this._normalDataPoints[0].date,
              this._normalDataPoints[Math.floor(this._normalDataPoints.length / 2)]?.date,
              this._normalDataPoints[this._normalDataPoints.length - 1].date,
            ].filter(Boolean)
          )
          .tickSize(0)
          .tickFormat(d3.timeFormat("%b %Y"))
      )
      .select(".domain")
      .remove();

    this._d3Group
      .selectAll(".tick text")
      .attr("class", "fg-gray")
      .style("font-size", "11px")
      .style("font-weight", "500")
      .attr("dy", "1em");
  }

  _drawTooltip() {
    this._d3Tooltip = d3
      .select(`#${this.element.id}`)
      .append("div")
      .attr(
        "class",
        "bg-container text-sm font-sans absolute p-3 border border-secondary rounded-lg pointer-events-none opacity-0 shadow-lg z-50"
      );
  }

  _trackMouseForShowingTooltip() {
    const bisectDate = d3.bisector((d) => d.date).left;

    this._d3Group
      .append("rect")
      .attr("class", "bg-container")
      .attr("width", this._d3ContainerWidth)
      .attr("height", this._d3ContainerHeight)
      .attr("fill", "none")
      .attr("pointer-events", "all")
      .on("mousemove", (event) => {
        const estimatedTooltipWidth = 200;
        const pageWidth = document.body.clientWidth;
        const tooltipX = event.pageX + 10;
        const overflowX = tooltipX + estimatedTooltipWidth - pageWidth;
        const adjustedX = overflowX > 0 ? event.pageX - overflowX - 20 : tooltipX;

        const [xPos] = d3.pointer(event);
        const x0 = bisectDate(this._normalDataPoints, this._d3XScale.invert(xPos), 1);
        const d0 = this._normalDataPoints[x0 - 1];
        const d1 = this._normalDataPoints[x0];
        if (!d0 || !d1) return;
        const d = xPos - this._d3XScale(d0.date) > this._d3XScale(d1.date) - xPos ? d1 : d0;

        this._d3Group.selectAll(".data-point-circle").remove();
        this._d3Group.selectAll(".guideline").remove();

        this._d3Group
          .append("line")
          .attr("class", "guideline fg-subdued")
          .attr("x1", this._d3XScale(d.date))
          .attr("y1", 0)
          .attr("x2", this._d3XScale(d.date))
          .attr("y2", this._d3ContainerHeight)
          .attr("stroke", "currentColor")
          .attr("stroke-dasharray", "4, 4");

        this._d3Group
          .append("circle")
          .attr("class", "data-point-circle")
          .attr("cx", this._d3XScale(d.date))
          .attr("cy", this._d3YScale(this._getDatumValue(d)))
          .attr("r", 8)
          .attr("fill", this._trendColor)
          .attr("fill-opacity", "0.2")
          .attr("pointer-events", "none");

        this._d3Group
          .append("circle")
          .attr("class", "data-point-circle")
          .attr("cx", this._d3XScale(d.date))
          .attr("cy", this._d3YScale(this._getDatumValue(d)))
          .attr("r", 4)
          .attr("fill", this._trendColor)
          .attr("pointer-events", "none");

        this._d3Tooltip
          .html(this._tooltipTemplate(d))
          .style("opacity", 1)
          .style("z-index", 999)
          .style("left", `${adjustedX}px`)
          .style("top", `${event.pageY - 10}px`);
      })
      .on("mouseout", (event) => {
        const hoveringOnGuideline = event.toElement?.classList.contains("guideline");

        if (!hoveringOnGuideline) {
          this._d3Group.selectAll(".guideline").remove();
          this._d3Group.selectAll(".data-point-circle").remove();
          this._d3Tooltip.style("opacity", 0);
        }
      });
  }

  _tooltipTemplate(datum) {
    return `
      <div style="margin-bottom: 4px; color: var(--color-gray-500); font-weight: 500;">
        ${datum.date_formatted}
      </div>
      <div class="flex items-center gap-2">
        <span class="text-lg font-semibold text-primary">
          ${this._extractFormattedValue(datum.value)}
        </span>
      </div>
    `;
  }

  _getDatumValue = (datum) => {
    return this._extractNumericValue(datum.value);
  };

  _extractNumericValue = (numeric) => {
    if (typeof numeric === "object" && "amount" in numeric) {
      return Number(numeric.amount);
    }
    return Number(numeric);
  };

  _extractFormattedValue = (numeric) => {
    if (typeof numeric === "object" && "formatted" in numeric) {
      return numeric.formatted;
    }
    return numeric;
  };

  _createMainSvg() {
    return this._d3Container
      .append("svg")
      .attr("width", this._d3InitialContainerWidth)
      .attr("height", this._d3InitialContainerHeight)
      .attr("viewBox", [0, 0, this._d3InitialContainerWidth, this._d3InitialContainerHeight]);
  }

  _createMainGroup() {
    return this._d3Svg
      .append("g")
      .attr("transform", `translate(${this._margin.left},${this._margin.top})`);
  }

  get _d3Svg() {
    if (!this._d3SvgMemo) {
      this._d3SvgMemo = this._createMainSvg();
    }
    return this._d3SvgMemo;
  }

  get _d3Group() {
    if (!this._d3GroupMemo) {
      this._d3GroupMemo = this._createMainGroup();
    }
    return this._d3GroupMemo;
  }

  get _margin() {
    if (this.useLabelsValue) {
      return { top: 20, right: 10, bottom: 30, left: 10 };
    }
    return { top: 10, right: 10, bottom: 10, left: 10 };
  }

  get _d3ContainerWidth() {
    return this._d3InitialContainerWidth - this._margin.left - this._margin.right;
  }

  get _d3ContainerHeight() {
    return this._d3InitialContainerHeight - this._margin.top - this._margin.bottom;
  }

  get _d3Container() {
    return d3.select(this.element);
  }

  get _trendColor() {
    return this.dataValue?.trend?.color || this.gradientColorValue || "var(--color-blue-500)";
  }

  get _gradientColor() {
    return this.gradientColorValue || this._trendColor;
  }

  get _curveFunction() {
    const curves = {
      monotoneX: d3.curveMonotoneX,
      cardinal: d3.curveCardinal,
      catmullRom: d3.curveCatmullRom,
      linear: d3.curveLinear,
      basis: d3.curveBasis,
      natural: d3.curveNatural,
    };
    return curves[this.curveTypeValue] || d3.curveMonotoneX;
  }

  get _d3Line() {
    return d3
      .line()
      .x((d) => this._d3XScale(d.date))
      .y((d) => this._d3YScale(this._getDatumValue(d)))
      .curve(this._curveFunction);
  }

  get _d3XScale() {
    return d3
      .scaleTime()
      .rangeRound([0, this._d3ContainerWidth])
      .domain(d3.extent(this._normalDataPoints, (d) => d.date));
  }

  get _d3YScale() {
    const dataMin = d3.min(this._normalDataPoints, this._getDatumValue);
    const dataMax = d3.max(this._normalDataPoints, this._getDatumValue);

    if (dataMin === dataMax) {
      const padding = dataMax === 0 ? 100 : Math.abs(dataMax) * 0.5;
      return d3
        .scaleLinear()
        .rangeRound([this._d3ContainerHeight, 0])
        .domain([dataMin - padding, dataMax + padding]);
    }

    const dataRange = dataMax - dataMin;
    const padding = dataRange * 0.1;

    return d3
      .scaleLinear()
      .rangeRound([this._d3ContainerHeight, 0])
      .domain([Math.max(0, dataMin - padding), dataMax + padding]);
  }

  _setupResizeObserver() {
    this._resizeObserver = new ResizeObserver(() => {
      this._reinstall();
    });
    this._resizeObserver.observe(this.element);
  }
}
