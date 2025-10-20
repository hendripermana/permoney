import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static values = {
    from: { type: String, default: "'wght' 400" },
    to: { type: String, default: "'wght' 700" },
    staggerDuration: { type: Number, default: 30 }, // in milliseconds
    duration: { type: Number, default: 500 }, // in milliseconds
  };

  connect() {
    this.setupLetters();
  }

  setupLetters() {
    const text = this.element.textContent.trim();
    this.element.innerHTML = "";

    // Use Array.from() or spread operator to properly handle Unicode characters including emojis
    // This ensures multi-byte characters like emojis are treated as single units
    const characters = Array.from(text);

    characters.forEach((char, index) => {
      const span = document.createElement("span");
      span.className = "inline-block whitespace-pre letter";
      span.textContent = char;
      span.style.fontVariationSettings = this.fromValue;
      span.style.transition = `font-variation-settings ${this.durationValue}ms ease-out`;
      span.style.transitionDelay = `${index * this.staggerDurationValue}ms`;
      this.element.appendChild(span);
    });
  }

  mouseenter() {
    const letters = this.element.querySelectorAll(".letter");
    letters.forEach((letter) => {
      letter.style.fontVariationSettings = this.toValue;
    });
  }

  mouseleave() {
    const letters = this.element.querySelectorAll(".letter");
    letters.forEach((letter) => {
      letter.style.fontVariationSettings = this.fromValue;
    });
  }
}
