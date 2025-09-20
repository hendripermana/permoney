import { Controller } from "@hotwired/stimulus";
import { debounce } from "debounce";

// Connects to data-controller="loan-form"
export default class LoanFormController extends Controller {
  static targets = [
    "principal",
    "startDate",
    "tenor",
    "frequency",
    "method",
    "rateOrProfit",
    "interestFree",
    "interestSection",
    "profitSection",
    "marginField",
    "profitShareField",
    "previewLink",
    "previewOverlay",
    "previewPanel",
    "previewFrame",
    "visibility",
    "debtKindField",
    "counterpartyTypeField",
    "advancedSection",
  ];

  static values = {
    previewBaseHref: String,
    previewFrame: String,
    previewAuto: Boolean,
  };

  static classes = ["hidden", "visible"];

  connect() {
    this.debouncedPreview = debounce(this.updatePreview.bind(this), 500);
    this.setupVisibilityToggling();
    this.setupInterestModeToggling();
  }

  disconnect() {
    if (this.debouncedPreview) {
      this.debouncedPreview.clear();
    }
  }

  // Handle changes to loan terms that affect schedule
  termsChanged(event) {
    if (this.previewAutoValue && this.hasPreviewFrameTarget) {
      this.debouncedPreview();
    }
    this.validateField(event.target);
  }

  // Toggle interest-free mode
  onInterestFreeChange(event) {
    const isInterestFree = event.target.checked;
    this.toggleInterestFields(isInterestFree);
  }

  // Handle Islamic product type changes
  onIslamicProductChange(event) {
    const productType = event.target.value;
    this.toggleIslamicFields(productType);
  }

  // Manual preview trigger
  preparePreview(event) {
    event.preventDefault();
    this.updatePreview();
    this.showPreviewOverlay();
  }

  // Close preview overlay
  closePreview() {
    this.hidePreviewOverlay();
  }

  // Private methods

  setupVisibilityToggling() {
    this.visibilityTargets.forEach((element) => {
      const visibilityValue = element.dataset.loanFormVisibilityValue;
      if (visibilityValue) {
        this.updateVisibility(element, visibilityValue);
      }
    });
  }

  setupInterestModeToggling() {
    if (this.hasInterestFreeTarget) {
      this.toggleInterestFields(this.interestFreeTarget.checked);
    }
  }

  updateVisibility(element, expectedMode) {
    const currentMode = this.getCurrentMode();
    const isVisible = this.shouldBeVisible(expectedMode, currentMode);

    element.classList.toggle(this.hiddenClass || "hidden", !isVisible);
    element.classList.toggle(this.visibleClass || "", isVisible);
  }

  getCurrentMode() {
    const debtKind = this.debtKindFieldTarget?.value || "personal";
    return debtKind === "personal" ? "personal" : "institution";
  }

  shouldBeVisible(expectedMode, currentMode) {
    if (expectedMode.includes(",")) {
      return expectedMode.split(",").includes(currentMode);
    }
    return expectedMode === currentMode;
  }

  toggleInterestFields(isInterestFree) {
    if (this.hasInterestSectionTarget) {
      this.interestSectionTarget.classList.toggle("hidden", isInterestFree);
    }
  }

  toggleIslamicFields(productType) {
    // Show/hide margin field for Murabaha
    if (this.hasMarginFieldTarget) {
      const showMargin = productType === "murabaha";
      this.marginFieldTarget.classList.toggle("hidden", !showMargin);
    }

    // Show/hide profit sharing field for partnership models
    if (this.hasProfitShareFieldTarget) {
      const showProfitShare = ["musyarakah", "mudharabah"].includes(
        productType,
      );
      this.profitShareFieldTarget.classList.toggle("hidden", !showProfitShare);
    }
  }

  updatePreview() {
    if (!this.hasPreviewFrameTarget || !this.previewBaseHrefValue) {
      return;
    }

    const formData = this.collectPreviewData();
    const url = this.buildPreviewUrl(formData);

    // Update turbo frame src to trigger preview load
    const frame = document.getElementById(this.previewFrameValue);
    if (frame) {
      frame.src = url;
    }
  }

  collectPreviewData() {
    const data = {};

    // Collect values from form fields
    if (this.hasPrincipalTarget)
      data.principal_amount = this.principalTarget.value;
    if (this.hasStartDateTarget) data.start_date = this.startDateTarget.value;
    if (this.hasTenorTarget) data.tenor_months = this.tenorTarget.value;
    if (this.hasFrequencyTarget)
      data.payment_frequency = this.frequencyTarget.value;
    if (this.hasMethodTarget) data.schedule_method = this.methodTarget.value;
    if (this.hasRateOrProfitTarget)
      data.rate_or_profit = this.rateOrProfitTarget.value;

    // Handle interest-free checkbox
    if (this.hasInterestFreeTarget) {
      data.interest_free = this.interestFreeTarget.checked;
    }

    return data;
  }

  buildPreviewUrl(formData) {
    const url = new URL(this.previewBaseHrefValue, window.location.origin);

    Object.entries(formData).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    });

    return url.toString();
  }

  showPreviewOverlay() {
    if (!this.hasPreviewOverlayTarget) return;

    const overlay = this.previewOverlayTarget;
    const panel = this.previewPanelTarget;

    // Show overlay
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");

    // Trigger animation
    requestAnimationFrame(() => {
      overlay.classList.add("opacity-100");
      if (panel) {
        panel.classList.remove("scale-95", "opacity-0");
        panel.classList.add("scale-100", "opacity-100");
      }
    });
  }

  hidePreviewOverlay() {
    if (!this.hasPreviewOverlayTarget) return;

    const overlay = this.previewOverlayTarget;
    const panel = this.previewPanelTarget;

    // Start exit animation
    overlay.classList.remove("opacity-100");
    if (panel) {
      panel.classList.remove("scale-100", "opacity-100");
      panel.classList.add("scale-95", "opacity-0");
    }

    // Hide after animation
    setTimeout(() => {
      overlay.classList.add("hidden");
      overlay.classList.remove("flex");
    }, 200);
  }

  validateField(field) {
    // Basic client-side validation
    if (field.type === "number") {
      this.validateNumberField(field);
    } else if (field.type === "email") {
      this.validateEmailField(field);
    }
  }

  validateNumberField(field) {
    const value = parseFloat(field.value);
    const min = parseFloat(field.min);
    const max = parseFloat(field.max);

    let isValid = true;

    if (!isNaN(min) && value < min) isValid = false;
    if (!isNaN(max) && value > max) isValid = false;
    if (isNaN(value) && field.required) isValid = false;

    this.toggleFieldError(field, !isValid);
  }

  validateEmailField(field) {
    if (field.value && !this.isValidEmail(field.value)) {
      this.toggleFieldError(field, true);
    } else {
      this.toggleFieldError(field, false);
    }
  }

  isValidEmail(email) {
    return /^[^\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
  }

  toggleFieldError(field, hasError) {
    const errorClass = "border-red-500";
    field.classList.toggle(errorClass, hasError);
  }
}
