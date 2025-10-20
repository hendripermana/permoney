# Pin npm packages by running ./bin/importmap

pin "application"
pin "@hotwired/turbo-rails", to: "turbo.min.js", preload: true
pin "@hotwired/stimulus", to: "stimulus.min.js"
pin "@hotwired/stimulus-loading", to: "stimulus-loading.js"
pin_all_from "app/javascript/controllers", under: "controllers"
pin_all_from "app/components", under: "controllers", to: ""
pin_all_from "app/javascript/services", under: "services", to: "services"
pin_all_from "app/javascript/hooks", under: "hooks"
pin_all_from "app/javascript/lib", under: "lib"
pin_all_from "app/javascript/components", under: "components"
pin "@github/hotkey", to: "@github--hotkey.js" # @3.1.1
pin "@simonwep/pickr", to: "@simonwep--pickr.js" # @1.9.1

# D3 packages
pin "d3" # @7.9.0
pin "d3-array", to: "shims/d3-array-default.js"
pin "d3-axis" # @3.0.0
pin "d3-brush" # @3.0.0
pin "d3-chord" # @3.0.1
pin "d3-color" # @3.1.0
pin "d3-contour" # @4.0.2
pin "d3-delaunay" # @6.0.4
pin "d3-dispatch" # @3.0.1
pin "d3-drag" # @3.0.0
pin "d3-dsv" # @3.0.1
pin "d3-ease" # @3.0.1
pin "d3-fetch" # @3.0.1
pin "d3-force" # @3.0.0
pin "d3-format" # @3.1.0
pin "d3-geo" # @3.1.1
pin "d3-hierarchy" # @3.1.2
pin "d3-interpolate" # @3.0.1
pin "d3-path" # @3.1.0
pin "d3-polygon" # @3.0.1
pin "d3-quadtree" # @3.0.1
pin "d3-random" # @3.0.1
pin "d3-scale" # @4.0.2
pin "d3-scale-chromatic" # @3.1.0
pin "d3-selection" # @3.0.0
pin "d3-shape", to: "shims/d3-shape-default.js"
pin "d3-time" # @3.1.0
pin "d3-time-format" # @4.1.0
pin "d3-timer" # @3.0.1
pin "d3-transition" # @3.0.1
pin "d3-zoom" # @3.0.0
pin "delaunator" # @5.0.1
pin "internmap" # @2.0.3
pin "robust-predicates" # @3.0.2
pin "@floating-ui/dom", to: "@floating-ui--dom.js" # @1.7.0
pin "@floating-ui/core", to: "@floating-ui--core.js" # @1.7.0
pin "@floating-ui/utils", to: "@floating-ui--utils.js" # @0.2.9

# React packages for enhanced animations
pin "react" # @19.1.1
pin "react-dom" # @19.1.1
pin "react-dom/client", to: "react-dom--client.js" # @19.1.1
pin "framer-motion" # @12.23.12
pin "zod" # @4.0.14
pin "@floating-ui/utils/dom", to: "@floating-ui--utils--dom.js" # @0.2.9
pin "d3-sankey" # @0.12.3
pin "d3-array-src", to: "d3-array.js"
pin "d3-shape-src", to: "d3-shape.js"
pin "motion-dom" # @12.23.23
pin "motion-utils" # @12.23.6
pin "react/jsx-runtime", to: "react--jsx-runtime.js" # @19.1.1
pin "scheduler" # @0.26.0
pin "lodash" # @4.17.21
pin "motion" # @12.23.24
pin "framer-motion/dom", to: "framer-motion--dom.js" # @12.23.24
