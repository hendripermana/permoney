import { Controller } from "@hotwired/stimulus";

export default class extends Controller {
  static targets = ["wrapper", "cube"];
  static values = {
    items: Array,
    width: { type: Number, default: 350 },
    height: { type: Number, default: 250 },
    direction: { type: String, default: "right" },
    autoPlay: { type: Boolean, default: false },
    autoPlayInterval: { type: Number, default: 3000 },
    enableDrag: { type: Boolean, default: true },
    perspective: { type: Number, default: 1000 },
  };

  connect() {
    this.currentItemIndex = 0;
    this.currentFrontFaceIndex = 1;
    this.prevIndex = this.itemsValue.length - 1;
    this.currentIndex = 0;
    this.nextIndex = 1;
    this.afterNextIndex = 2;
    this.currentRotation = 0;
    this.isRotating = false;
    this.pendingIndexChange = null;
    this.isDragging = false;
    this.startPosition = { x: 0, y: 0 };
    this.startRotation = 0;
    this.rotateX = 0;
    this.rotateY = 0;

    this.render();
    this.setupEventListeners();

    // Start auto-play after a short delay to ensure rendering is complete
    if (this.autoPlayValue) {
      setTimeout(() => {
        this.startAutoPlay();
      }, 100);
    }

    // Make methods available for external calls
    this.element.boxCarousel = {
      next: () => this.next(),
      prev: () => this.prev(),
      getCurrentIndex: () => this.currentItemIndex,
    };
  }

  disconnect() {
    this.stopAutoPlay();
    this.removeEventListeners();
  }

  render() {
    const depth = this.getDepth();
    const faceTransforms = this.getFaceTransforms(depth);

    this.wrapperTarget.innerHTML = `
      <div class="box-carousel-scene" style="width: ${this.widthValue}px; height: ${this.heightValue}px; perspective: ${this.perspectiveValue}px;" tabindex="0">
        <div class="box-carousel-cube" data-box-carousel-target="cube">
          ${this.renderFace(0, faceTransforms[0], this.prevIndex)}
          ${this.renderFace(1, faceTransforms[1], this.currentIndex)}
          ${this.renderFace(2, faceTransforms[2], this.nextIndex)}
          ${this.renderFace(3, faceTransforms[3], this.afterNextIndex)}
        </div>
      </div>
    `;

    // Wait for next tick to ensure DOM is updated and target is available
    setTimeout(() => {
      if (this.hasCubeTarget) {
        this.updateTransform();
      }
    }, 0);
  }

  renderFace(_faceIndex, transform, itemIndex) {
    const item = this.itemsValue[itemIndex];
    if (!item) return "";

    const mediaContent =
      item.type === "video"
        ? `<video src="${item.src}" ${item.poster ? `poster="${item.poster}"` : ""} class="box-carousel-media" muted loop autoplay playsinline></video>`
        : `<img src="${item.src}" alt="${item.alt || ""}" class="box-carousel-media" draggable="false">`;

    return `
      <div class="box-carousel-face" style="transform: ${transform}; width: ${this.widthValue}px; height: ${this.heightValue}px;">
        ${mediaContent}
      </div>
    `;
  }

  getDepth() {
    return this.directionValue === "top" || this.directionValue === "bottom"
      ? this.heightValue
      : this.widthValue;
  }

  getFaceTransforms(depth) {
    const { widthValue: w, heightValue: h } = this;

    switch (this.directionValue) {
      case "left":
        return [
          `rotateY(-90deg) translateZ(${w / 2}px)`,
          `rotateY(0deg) translateZ(${depth / 2}px)`,
          `rotateY(90deg) translateZ(${w / 2}px)`,
          `rotateY(180deg) translateZ(${depth / 2}px)`,
        ];
      case "top":
        return [
          `rotateX(90deg) translateZ(${h / 2}px)`,
          `rotateY(0deg) translateZ(${depth / 2}px)`,
          `rotateX(-90deg) translateZ(${h / 2}px)`,
          `rotateY(180deg) translateZ(${depth / 2}px) rotateZ(180deg)`,
        ];
      case "right":
        return [
          `rotateY(90deg) translateZ(${w / 2}px)`,
          `rotateY(0deg) translateZ(${depth / 2}px)`,
          `rotateY(-90deg) translateZ(${w / 2}px)`,
          `rotateY(180deg) translateZ(${depth / 2}px)`,
        ];
      case "bottom":
        return [
          `rotateX(-90deg) translateZ(${h / 2}px)`,
          `rotateY(0deg) translateZ(${depth / 2}px)`,
          `rotateX(90deg) translateZ(${h / 2}px)`,
          `rotateY(180deg) translateZ(${depth / 2}px) rotateZ(180deg)`,
        ];
      default:
        return [
          `rotateY(-90deg) translateZ(${w / 2}px)`,
          `rotateY(0deg) translateZ(${depth / 2}px)`,
          `rotateY(90deg) translateZ(${w / 2}px)`,
          `rotateY(180deg) translateZ(${depth / 2}px)`,
        ];
    }
  }

  updateTransform(smooth = false) {
    if (!this.hasCubeTarget) return;

    const depth = this.getDepth();
    const transform = `translateZ(-${depth / 2}px) rotateX(${this.rotateX}deg) rotateY(${this.rotateY}deg)`;

    if (smooth) {
      this.cubeTarget.classList.add("animating");
    } else {
      this.cubeTarget.classList.remove("animating");
    }

    this.cubeTarget.style.transform = transform;
  }

  setupEventListeners() {
    this.boundHandleKeyDown = this.handleKeyDown.bind(this);
    this.boundHandleDragStart = this.handleDragStart.bind(this);
    this.boundHandleDragMove = this.handleDragMove.bind(this);
    this.boundHandleDragEnd = this.handleDragEnd.bind(this);

    const scene = this.element.querySelector(".box-carousel-scene");
    if (scene) {
      scene.addEventListener("keydown", this.boundHandleKeyDown);

      if (this.enableDragValue) {
        scene.addEventListener("mousedown", this.boundHandleDragStart);
        scene.addEventListener("touchstart", this.boundHandleDragStart, {
          passive: false,
        });
      }
    }
  }

  removeEventListeners() {
    const scene = this.element.querySelector(".box-carousel-scene");
    if (scene) {
      scene.removeEventListener("keydown", this.boundHandleKeyDown);
      scene.removeEventListener("mousedown", this.boundHandleDragStart);
      scene.removeEventListener("touchstart", this.boundHandleDragStart);
    }
    window.removeEventListener("mousemove", this.boundHandleDragMove);
    window.removeEventListener("mouseup", this.boundHandleDragEnd);
    window.removeEventListener("touchmove", this.boundHandleDragMove);
    window.removeEventListener("touchend", this.boundHandleDragEnd);
  }

  handleKeyDown(e) {
    if (this.isRotating) return;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        if (this.directionValue === "left" || this.directionValue === "right") {
          this.prev();
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (this.directionValue === "left" || this.directionValue === "right") {
          this.next();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (this.directionValue === "top" || this.directionValue === "bottom") {
          this.prev();
        }
        break;
      case "ArrowDown":
        e.preventDefault();
        if (this.directionValue === "top" || this.directionValue === "bottom") {
          this.next();
        }
        break;
    }
  }

  handleDragStart(e) {
    if (!this.enableDragValue || this.isRotating) return;

    this.isDragging = true;
    const point = e.touches ? e.touches[0] : e;
    this.startPosition = { x: point.clientX, y: point.clientY };
    this.startRotation = this.currentRotation;
    this.dragStartRotateX = this.rotateX;
    this.dragStartRotateY = this.rotateY;

    e.preventDefault();

    window.addEventListener("mousemove", this.boundHandleDragMove);
    window.addEventListener("mouseup", this.boundHandleDragEnd);
    window.addEventListener("touchmove", this.boundHandleDragMove, {
      passive: false,
    });
    window.addEventListener("touchend", this.boundHandleDragEnd);
  }

  handleDragMove(e) {
    if (!this.isDragging || this.isRotating) return;

    const point = e.touches ? e.touches[0] : e;
    const deltaX = point.clientX - this.startPosition.x;
    const deltaY = point.clientY - this.startPosition.y;

    const isVertical = this.directionValue === "top" || this.directionValue === "bottom";
    const delta = isVertical ? deltaY : deltaX;
    const rotationDelta = (delta * 0.5) / 2;

    let newRotation = this.startRotation;
    if (this.directionValue === "top" || this.directionValue === "right") {
      newRotation += rotationDelta;
    } else {
      newRotation -= rotationDelta;
    }

    const minRotation = this.startRotation - 120;
    const maxRotation = this.startRotation + 120;
    newRotation = Math.max(minRotation, Math.min(maxRotation, newRotation));

    if (isVertical) {
      this.rotateX = newRotation;
    } else {
      this.rotateY = newRotation;
    }

    this.updateTransform(false);
  }

  handleDragEnd() {
    if (!this.isDragging) return;

    this.isDragging = false;

    const isVertical = this.directionValue === "top" || this.directionValue === "bottom";
    const currentValue = isVertical ? this.rotateX : this.rotateY;

    const quarterRotations = Math.round(currentValue / 90);
    const snappedRotation = quarterRotations * 90;

    const rotationDifference = snappedRotation - this.currentRotation;
    const steps = Math.round(rotationDifference / 90);

    if (steps !== 0) {
      this.isRotating = true;

      let newItemIndex = this.currentItemIndex;
      for (let i = 0; i < Math.abs(steps); i++) {
        if (steps > 0) {
          newItemIndex = (newItemIndex + 1) % this.itemsValue.length;
        } else {
          newItemIndex = newItemIndex === 0 ? this.itemsValue.length - 1 : newItemIndex - 1;
        }
      }

      this.pendingIndexChange = newItemIndex;

      if (isVertical) {
        this.rotateX = snappedRotation;
      } else {
        this.rotateY = snappedRotation;
      }

      this.updateTransform(true);

      setTimeout(() => {
        this.handleAnimationComplete(steps > 0 ? "next" : "prev");
        this.currentRotation = snappedRotation;
      }, 1250);
    } else {
      if (isVertical) {
        this.rotateX = this.currentRotation;
      } else {
        this.rotateY = this.currentRotation;
      }
      this.updateTransform(true);
    }

    window.removeEventListener("mousemove", this.boundHandleDragMove);
    window.removeEventListener("mouseup", this.boundHandleDragEnd);
    window.removeEventListener("touchmove", this.boundHandleDragMove);
    window.removeEventListener("touchend", this.boundHandleDragEnd);
  }

  next() {
    if (this.itemsValue.length === 0 || this.isRotating) return;

    this.isRotating = true;
    const newIndex = (this.currentItemIndex + 1) % this.itemsValue.length;
    this.pendingIndexChange = newIndex;

    const isVertical = this.directionValue === "top" || this.directionValue === "bottom";
    const rotation = this.currentRotation + (this.directionValue === "left" ? -90 : 90);

    if (isVertical) {
      this.rotateX = rotation;
    } else {
      this.rotateY = rotation;
    }

    this.updateTransform(true);

    setTimeout(() => {
      this.handleAnimationComplete("next");
      this.currentRotation = rotation;
    }, 1250);
  }

  prev() {
    if (this.itemsValue.length === 0 || this.isRotating) return;

    this.isRotating = true;
    const newIndex =
      this.currentItemIndex === 0 ? this.itemsValue.length - 1 : this.currentItemIndex - 1;
    this.pendingIndexChange = newIndex;

    const isVertical = this.directionValue === "top" || this.directionValue === "bottom";
    const rotation = this.currentRotation + (this.directionValue === "left" ? 90 : -90);

    if (isVertical) {
      this.rotateX = rotation;
    } else {
      this.rotateY = rotation;
    }

    this.updateTransform(true);

    setTimeout(() => {
      this.handleAnimationComplete("prev");
      this.currentRotation = rotation;
    }, 1250);
  }

  handleAnimationComplete(triggeredBy) {
    if (this.isRotating && this.pendingIndexChange !== null) {
      this.isRotating = false;

      let newFrontFaceIndex;
      let currentBackFaceIndex;

      if (triggeredBy === "next") {
        newFrontFaceIndex = (this.currentFrontFaceIndex + 1) % 4;
        currentBackFaceIndex = (newFrontFaceIndex + 2) % 4;
      } else {
        newFrontFaceIndex = (this.currentFrontFaceIndex - 1 + 4) % 4;
        currentBackFaceIndex = (newFrontFaceIndex + 3) % 4;
      }

      this.currentItemIndex = this.pendingIndexChange;

      const indexOffset = triggeredBy === "next" ? 2 : -1;

      if (currentBackFaceIndex === 0) {
        this.prevIndex =
          (this.pendingIndexChange + indexOffset + this.itemsValue.length) % this.itemsValue.length;
      } else if (currentBackFaceIndex === 1) {
        this.currentIndex =
          (this.pendingIndexChange + indexOffset + this.itemsValue.length) % this.itemsValue.length;
      } else if (currentBackFaceIndex === 2) {
        this.nextIndex =
          (this.pendingIndexChange + indexOffset + this.itemsValue.length) % this.itemsValue.length;
      } else if (currentBackFaceIndex === 3) {
        this.afterNextIndex =
          (this.pendingIndexChange + indexOffset + this.itemsValue.length) % this.itemsValue.length;
      }

      this.pendingIndexChange = null;
      this.currentFrontFaceIndex = newFrontFaceIndex;

      this.updateBackFace(currentBackFaceIndex);
    }
  }

  updateBackFace(faceIndex) {
    if (!this.hasCubeTarget) return;

    const faces = this.cubeTarget.querySelectorAll(".box-carousel-face");
    if (faces[faceIndex]) {
      const itemIndex = [this.prevIndex, this.currentIndex, this.nextIndex, this.afterNextIndex][
        faceIndex
      ];
      const item = this.itemsValue[itemIndex];

      if (item) {
        const mediaContent =
          item.type === "video"
            ? `<video src="${item.src}" ${item.poster ? `poster="${item.poster}"` : ""} class="box-carousel-media" muted loop autoplay playsinline></video>`
            : `<img src="${item.src}" alt="${item.alt || ""}" class="box-carousel-media" draggable="false">`;

        faces[faceIndex].innerHTML = mediaContent;
      }
    }
  }

  startAutoPlay() {
    this.autoPlayTimer = setInterval(() => {
      this.next();
    }, this.autoPlayIntervalValue);
  }

  stopAutoPlay() {
    if (this.autoPlayTimer) {
      clearInterval(this.autoPlayTimer);
      this.autoPlayTimer = null;
    }
  }
}
