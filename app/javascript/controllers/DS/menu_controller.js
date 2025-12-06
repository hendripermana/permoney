import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Controller } from "@hotwired/stimulus";

/**
 * A "menu" can contain arbitrary content including non-clickable items, links, buttons, and forms.
 *
 * Key features:
 * - Uses floating-ui with flip middleware for smart positioning (avoids overflow)
 * - Moves content to body to avoid overflow:hidden clipping issues
 * - Dispatches custom event to close other open menus (prevents stacking)
 * - Stores direct element references since targets are lost when moved to body
 */
export default class extends Controller {
  static targets = ["button", "content"];

  static values = {
    show: Boolean,
    placement: { type: String, default: "bottom-end" },
    offset: { type: Number, default: 6 },
  };

  connect() {
    // Store direct references before moving to body (targets won't work after move)
    this._buttonEl = this.hasButtonTarget ? this.buttonTarget : null;
    this._contentEl = this.hasContentTarget ? this.contentTarget : null;

    if (!this._buttonEl || !this._contentEl) {
      console.warn("DS--menu: Missing button or content target");
      return;
    }

    this.show = this.showValue;
    this.boundUpdate = this.update.bind(this);
    this.addEventListeners();

    // Move content to body to avoid overflow:hidden clipping
    this.moveContentToBody();
    this.startAutoUpdate();
  }

  disconnect() {
    this.removeEventListeners();
    this.stopAutoUpdate();
    this.close();

    // Remove content from body when disconnecting
    this.removeContentFromBody();

    // Clear references
    this._buttonEl = null;
    this._contentEl = null;
  }

  // Move the dropdown content to body to escape overflow:hidden containers
  moveContentToBody() {
    if (this._contentEl && this._contentEl.parentElement !== document.body) {
      this._originalParent = this._contentEl.parentElement;
      this._originalNextSibling = this._contentEl.nextSibling;
      document.body.appendChild(this._contentEl);
    }
  }

  // Restore content to original position when cleaning up
  removeContentFromBody() {
    if (this._contentEl && this._originalParent && document.body.contains(this._contentEl)) {
      try {
        if (this._originalNextSibling && this._originalParent.contains(this._originalNextSibling)) {
          this._originalParent.insertBefore(this._contentEl, this._originalNextSibling);
        } else if (document.contains(this._originalParent)) {
          this._originalParent.appendChild(this._contentEl);
        }
      } catch {
        // Parent may have been removed from DOM during Turbo navigation
      }
    }
    this._originalParent = null;
    this._originalNextSibling = null;
  }

  addEventListeners() {
    if (!this._buttonEl) return;

    this.toggleHandler = this.toggle.bind(this);
    this.keydownHandler = this.handleKeydown.bind(this);
    this.outsideClickHandler = this.handleOutsideClick.bind(this);
    this.turboLoadHandler = this.handleTurboLoad.bind(this);
    this.turboBeforeVisitHandler = this.handleTurboBeforeVisit.bind(this);
    this.closeOtherMenusHandler = this.handleCloseOtherMenus.bind(this);

    this._buttonEl.addEventListener("click", this.toggleHandler);
    this.element.addEventListener("keydown", this.keydownHandler);
    document.addEventListener("click", this.outsideClickHandler);
    document.addEventListener("turbo:load", this.turboLoadHandler);
    document.addEventListener("turbo:before-visit", this.turboBeforeVisitHandler);
    document.addEventListener("ds:menu:close-others", this.closeOtherMenusHandler);
  }

  removeEventListeners() {
    if (this.toggleHandler && this._buttonEl) {
      this._buttonEl.removeEventListener("click", this.toggleHandler);
    }
    if (this.keydownHandler) {
      this.element.removeEventListener("keydown", this.keydownHandler);
    }
    if (this.outsideClickHandler) {
      document.removeEventListener("click", this.outsideClickHandler);
    }
    if (this.turboLoadHandler) {
      document.removeEventListener("turbo:load", this.turboLoadHandler);
    }
    if (this.turboBeforeVisitHandler) {
      document.removeEventListener("turbo:before-visit", this.turboBeforeVisitHandler);
    }
    if (this.closeOtherMenusHandler) {
      document.removeEventListener("ds:menu:close-others", this.closeOtherMenusHandler);
    }
  }

  handleTurboLoad() {
    this.close();
  }

  handleTurboBeforeVisit() {
    this.close();
  }

  handleCloseOtherMenus(event) {
    if (event.detail.sourceElement !== this.element && this.show) {
      this.close();
    }
  }

  handleOutsideClick(event) {
    if (!this._contentEl) return;

    if (
      this.show &&
      !this.element.contains(event.target) &&
      !this._contentEl.contains(event.target)
    ) {
      this.close();
    }
  }

  closeOnItemClick(_event) {
    this.close();
  }

  handleKeydown(event) {
    if (event.key === "Escape") {
      this.close();
      if (this._buttonEl) this._buttonEl.focus();
    }
  }

  toggle(event) {
    if (!this._contentEl) return;

    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    this.show = !this.show;
    this._contentEl.classList.toggle("hidden", !this.show);

    if (this.show) {
      document.dispatchEvent(
        new CustomEvent("ds:menu:close-others", {
          detail: { sourceElement: this.element },
        })
      );

      this.update();
      this.focusFirstElement();
    }
  }

  close() {
    if (!this._contentEl) return;

    this.show = false;
    this._contentEl.classList.add("hidden");
  }

  focusFirstElement() {
    if (!this._contentEl) return;

    const focusableElements =
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const firstFocusableElement = this._contentEl.querySelectorAll(focusableElements)[0];
    if (firstFocusableElement) {
      firstFocusableElement.focus();
    }
  }

  startAutoUpdate() {
    if (!this._cleanup && this._buttonEl && this._contentEl) {
      this._cleanup = autoUpdate(this._buttonEl, this._contentEl, this.boundUpdate);
    }
  }

  stopAutoUpdate() {
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
  }

  update() {
    if (!this._buttonEl || !this._contentEl) return;

    const isSmallScreen = !window.matchMedia("(min-width: 768px)").matches;

    computePosition(this._buttonEl, this._contentEl, {
      placement: isSmallScreen ? "bottom" : this.placementValue,
      middleware: [
        offset(this.offsetValue),
        flip({ fallbackPlacements: ["top-end", "top-start", "bottom-start"] }),
        shift({ padding: 8 }),
      ],
      strategy: "fixed",
    }).then(({ x, y }) => {
      if (!this._contentEl) return;

      if (isSmallScreen) {
        Object.assign(this._contentEl.style, {
          position: "fixed",
          left: "0px",
          width: "100vw",
          top: `${y}px`,
        });
      } else {
        Object.assign(this._contentEl.style, {
          position: "fixed",
          left: `${x}px`,
          top: `${y}px`,
          width: "",
        });
      }
    });
  }
}
