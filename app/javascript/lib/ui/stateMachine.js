/**
 * Simple finite state machine for managing UI states
 * Replaces ad-hoc boolean flags with a clear state flow
 */

export class StateMachine {
  constructor(initialState, states = {}) {
    this.currentState = initialState;
    this.states = states;
    this.listeners = new Set();
    this.history = [initialState];
  }

  // Get current state
  getState() {
    return this.currentState;
  }

  // Check if in specific state
  is(state) {
    return this.currentState === state;
  }

  // Check if in any of the provided states
  isAny(...states) {
    return states.includes(this.currentState);
  }

  // Transition to new state
  transition(newState, data = null) {
    const previousState = this.currentState;

    // Validate transition if states config provided
    if (this.states[previousState]?.transitions) {
      const allowedTransitions = this.states[previousState].transitions;
      if (!allowedTransitions.includes(newState)) {
        console.warn(`Invalid transition from ${previousState} to ${newState}`);
        return false;
      }
    }

    this.currentState = newState;
    this.history.push(newState);

    // Keep history manageable
    if (this.history.length > 10) {
      this.history.shift();
    }

    // Notify listeners
    this.listeners.forEach((listener) => {
      try {
        listener({
          from: previousState,
          to: newState,
          data,
          machine: this,
        });
      } catch (error) {
        console.error("State machine listener error:", error);
      }
    });

    return true;
  }

  // Subscribe to state changes
  subscribe(listener) {
    this.listeners.add(listener);

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Get state history
  getHistory() {
    return [...this.history];
  }

  // Reset to initial state
  reset(initialState = this.history[0]) {
    this.transition(initialState);
  }
}

// Predefined state machine for data fetching
export function createDataFetchStateMachine() {
  return new StateMachine("idle", {
    idle: {
      transitions: ["loading"],
    },
    loading: {
      transitions: ["success", "error", "idle"],
    },
    success: {
      transitions: ["loading", "idle"],
    },
    error: {
      transitions: ["loading", "idle"],
    },
  });
}

// Predefined state machine for UI components
export function createUIStateMachine() {
  return new StateMachine("hidden", {
    hidden: {
      transitions: ["showing", "visible"],
    },
    showing: {
      transitions: ["visible", "hiding", "hidden"],
    },
    visible: {
      transitions: ["hiding", "hidden"],
    },
    hiding: {
      transitions: ["hidden", "showing", "visible"],
    },
  });
}

export default StateMachine;
