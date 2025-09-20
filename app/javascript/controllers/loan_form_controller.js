import { Controller } from "@hotwired/stimulus";
import { debounce } from "debounce";

// Connects to data-controller="loan-wizard"
class LoanWizardController extends Controller {
  static targets = ["steps", "content", "currentStep", "loanType"];
  static values = {
    currentStep: String,
    loanType: String,
    completedSteps: Array
  };

  connect() {
    this.initializeWizard();
  }

  initializeWizard() {
    if (!this.currentStepValue) {
      this.currentStepValue = 'type';
    }
    this.updateUI();
  }

  selectType(event) {
    const type = event.currentTarget.dataset.typeValue;
    this.loanTypeValue = type;
    this.updateFormFields(type);
    this.nextStep();
  }

  nextStep() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    if (currentIndex < steps.length - 1 && this.validateCurrentStep()) {
      this.currentStepValue = steps[currentIndex + 1];
      this.updateUI();
    }
  }

  previousStep() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    if (currentIndex > 0) {
      this.currentStepValue = steps[currentIndex - 1];
      this.updateUI();
    }
  }

  updateUI() {
    this.updateStepIndicators();
    this.updateContentVisibility();
    this.updateActionButtons();
  }

  updateStepIndicators() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    steps.forEach((step, index) => {
      const indicator = this.element.querySelector(`[data-step="${step}"]`);
      if (indicator) {
        const isCompleted = this.completedStepsValue.includes(step) || index < currentIndex;
        const isActive = step === this.currentStepValue;

        indicator.classList.toggle('bg-primary', isCompleted);
        indicator.classList.toggle('bg-secondary', !isCompleted);
        indicator.classList.toggle('text-white', isCompleted);
        indicator.classList.toggle('text-secondary', !isCompleted);
      }
    });
  }

  updateContentVisibility() {
    const contents = this.element.querySelectorAll('[data-step-content]');
    contents.forEach(content => {
      content.style.display = content.dataset.stepContent === this.currentStepValue ? 'block' : 'none';
    });
  }

  updateActionButtons() {
    const backBtn = this.element.querySelector('[data-action*="previousStep"]');
    const nextBtn = this.element.querySelector('[data-action*="nextStep"]');

    if (backBtn) {
      backBtn.style.display = this.currentStepValue === 'type' ? 'none' : 'inline-flex';
    }

    if (nextBtn) {
      const isLastStep = this.currentStepValue === 'review';
      nextBtn.textContent = isLastStep ? 'Create Loan' : 'Next';
    }
  }

  updateFormFields(type) {
    const debtKindField = this.element.querySelector('[name*="debt_kind"]');
    const counterpartyTypeField = this.element.querySelector('[name*="counterparty_type"]');

    if (debtKindField) {
      debtKindField.value = type;
    }

    if (counterpartyTypeField) {
      counterpartyTypeField.value = type === 'personal' ? 'person' : 'institution';
    }
  }

  validateCurrentStep() {
    switch (this.currentStepValue) {
      case 'type':
        return this.validateTypeStep();
      case 'basic':
        return this.validateBasicStep();
      case 'terms':
        return this.validateTermsStep();
      default:
        return true;
    }
  }

  validateTypeStep() {
    return this.loanTypeValue && ['personal', 'institutional'].includes(this.loanTypeValue);
  }

  validateBasicStep() {
    const counterpartyName = this.element.querySelector('input[name*="counterparty_name"]');
    return counterpartyName && counterpartyName.value.trim().length > 0;
  }

  validateTermsStep() {
    const principal = this.element.querySelector('input[name*="initial_balance"]');
    const tenor = this.element.querySelector('input[name*="tenor_months"]');

    const principalValid = principal && parseFloat(principal.value) > 0;
    const tenorValid = tenor && parseInt(tenor.value) > 0;

    if (!principalValid) {
      this.showError(principal, 'Principal amount is required');
    }

    if (!tenorValid) {
      this.showError(tenor, 'Number of installments is required');
    }

    return principalValid && tenorValid;
  }

  showError(field, message) {
    if (!field) return;

    this.clearError(field);

    field.classList.add('border-red-500');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'text-red-500 text-xs mt-1';
    errorDiv.textContent = message;
    field.parentNode.appendChild(errorDiv);
  }

  clearError(field) {
    if (!field) return;

    field.classList.remove('border-red-500');
    const error = field.parentNode.querySelector('.text-red-500');
    if (error) error.remove();
  }
}

// Connects to data-controller="loan-form"
export default class extends Controller {
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

  // Wizard-specific targets and values
  static targets = [
    ...this.targets,
    "wizardSteps",
    "wizardContent",
    "wizardActions",
    "typeSelection",
    "currentStep",
    "loanType"
  ];

  static values = {
    ...this.values,
    currentStep: String,
    loanType: String,
    completedSteps: Array
  };

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
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  toggleFieldError(field, hasError) {
    const errorClass = "border-red-500";
    field.classList.toggle(errorClass, hasError);
  }

  // Wizard-specific methods
  selectType(event) {
    const type = event.currentTarget.dataset.typeValue;
    this.loanTypeValue = type;

    // Update hidden fields
    if (this.hasDebtKindFieldTarget) {
      this.debtKindFieldTarget.value = type;
    }

    // Update UI
    this.updateStepIndicators();
    this.validateCurrentStep();
  }

  nextStep() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    if (currentIndex < steps.length - 1) {
      const nextStep = steps[currentIndex + 1];

      // Validate current step before proceeding
      if (this.validateCurrentStep()) {
        this.currentStepValue = nextStep;
        this.updateWizardUI();
      }
    } else {
      // Submit form
      this.submitForm();
    }
  }

  previousStep() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    if (currentIndex > 0) {
      this.currentStepValue = steps[currentIndex - 1];
      this.updateWizardUI();
    }
  }

  updateWizardUI() {
    // Update step indicators
    this.updateStepIndicators();

    // Update content visibility
    this.updateContentVisibility();

    // Update action buttons
    this.updateActionButtons();
  }

  updateStepIndicators() {
    const steps = ['type', 'basic', 'terms', 'review'];
    const currentIndex = steps.indexOf(this.currentStepValue);

    steps.forEach((step, index) => {
      const indicator = this.element.querySelector(`[data-step="${step}"]`);
      if (indicator) {
        const isCompleted = this.completedStepsValue.includes(step) || index < currentIndex;
        const isActive = step === this.currentStepValue;

        indicator.classList.toggle('completed', isCompleted);
        indicator.classList.toggle('active', isActive);
        indicator.classList.toggle('pending', !isCompleted && !isActive);
      }
    });
  }

  updateContentVisibility() {
    // Hide all step contents
    const stepContents = this.element.querySelectorAll('[data-step-content]');
    stepContents.forEach(content => {
      content.classList.add('hidden');
    });

    // Show current step content
    const currentContent = this.element.querySelector(`[data-step-content="${this.currentStepValue}"]`);
    if (currentContent) {
      currentContent.classList.remove('hidden');
    }
  }

  updateActionButtons() {
    const backButton = this.element.querySelector('[data-action*="previousStep"]');
    const nextButton = this.element.querySelector('[data-action*="nextStep"]');

    if (backButton) {
      backButton.style.display = this.currentStepValue === 'type' ? 'none' : 'inline-flex';
    }

    if (nextButton) {
      const steps = ['type', 'basic', 'terms', 'review'];
      const isLastStep = steps.indexOf(this.currentStepValue) === steps.length - 1;
      nextButton.textContent = isLastStep ? 'Create Loan' : 'Next';
    }
  }

  validateCurrentStep() {
    let isValid = true;

    switch (this.currentStepValue) {
      case 'type':
        isValid = this.validateTypeStep();
        break;
      case 'basic':
        isValid = this.validateBasicStep();
        break;
      case 'terms':
        isValid = this.validateTermsStep();
        break;
      case 'review':
        isValid = true; // Review step doesn't require validation
        break;
    }

    return isValid;
  }

  validateTypeStep() {
    const selectedType = this.loanTypeValue;
    return selectedType && ['personal', 'institutional'].includes(selectedType);
  }

  validateBasicStep() {
    const counterpartyName = this.element.querySelector('input[name*="counterparty_name"]');
    if (!counterpartyName || !counterpartyName.value.trim()) {
      this.showFieldError(counterpartyName, 'Counterparty name is required');
      return false;
    }

    return true;
  }

  validateTermsStep() {
    const principal = this.element.querySelector('input[name*="initial_balance"]');
    const tenor = this.element.querySelector('input[name*="tenor_months"]');

    if (!principal || !principal.value || parseFloat(principal.value) <= 0) {
      this.showFieldError(principal, 'Principal amount is required');
      return false;
    }

    if (!tenor || !tenor.value || parseInt(tenor.value) <= 0) {
      this.showFieldError(tenor, 'Number of installments is required');
      return false;
    }

    return true;
  }

  showFieldError(field, message) {
    if (!field) return;

    // Remove existing error
    this.clearFieldError(field);

    // Add error styling
    field.classList.add('border-red-500');

    // Add error message
    const errorElement = document.createElement('div');
    errorElement.className = 'text-red-500 text-xs mt-1';
    errorElement.textContent = message;
    errorElement.dataset.errorFor = field.name || field.id;

    field.parentNode.appendChild(errorElement);
  }

  clearFieldError(field) {
    if (!field) return;

    field.classList.remove('border-red-500');

    const errorElement = field.parentNode.querySelector(`[data-error-for="${field.name || field.id}"]`);
    if (errorElement) {
      errorElement.remove();
    }
  }

  submitForm() {
    const form = this.element.closest('form');
    if (form) {
      form.requestSubmit();
    }
  }

  // Enhanced form methods for wizard
  termsChanged(event) {
    if (this.currentStepValue === 'terms') {
      this.debouncedPreview();
    }
    this.validateField(event.target);
  }

  // Override connect to handle wizard initialization
  connect() {
    // Call original connect logic
    this.debouncedPreview = debounce(this.updatePreview.bind(this), 500);
    this.setupVisibilityToggling();
    this.setupInterestModeToggling();

    // Initialize wizard if in wizard mode
    if (this.element.classList.contains('loan-wizard')) {
      this.initializeWizard();
    }
  }

  initializeWizard() {
    // Set initial step if not provided
    if (!this.currentStepValue) {
      this.currentStepValue = 'type';
    }

    // Initialize UI
    this.updateWizardUI();

    // Auto-advance from type step if loan type is already selected
    if (this.currentStepValue === 'type' && this.loanTypeValue) {
      setTimeout(() => {
        this.nextStep();
      }, 500);
    }
  }
}

// Export both controllers
export { LoanWizardController };
export default LoanFormController;
