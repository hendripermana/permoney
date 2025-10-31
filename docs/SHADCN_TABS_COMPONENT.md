# Shadcn-Style Tabs Component for Rails 8.1

Modern, accessible tabs component following shadcn/ui design principles, converted to pure Rails with Stimulus.

---

## 🎯 Features

- ✅ **Shadcn/ui Aesthetics**: Clean, modern design matching shadcn/ui style
- ✅ **Icon Support**: Optional Lucide icons for each tab
- ✅ **Keyboard Navigation**: Arrow keys, Home, End support
- ✅ **URL Synchronization**: Optional URL parameter tracking
- ✅ **Fully Accessible**: ARIA attributes and semantic HTML
- ✅ **Dark Mode**: Complete theme support
- ✅ **Rails 8.1 Ready**: Proper Stimulus data attribute conventions
- ✅ **Zero Dependencies**: No React, no complex build steps
- ✅ **Performance Optimized**: Minimal JavaScript, no framework overhead

---

## 📦 Installation

Files are already in the codebase:
```
app/components/shadcn/
├── tabs_component.rb           # ViewComponent
├── tabs_component.html.erb     # Template
└── tabs_controller.js          # Stimulus controller
```

No additional dependencies required!

---

## 🚀 Usage

### Basic Example

```erb
<%= render Shadcn::TabsComponent.new(default_value: "all") do |tabs| %>
  <% tabs.with_tab(value: "all", label: "All") do %>
    <p>All content goes here</p>
  <% end %>

  <% tabs.with_tab(value: "active", label: "Active") do %>
    <p>Active content goes here</p>
  <% end %>
<% end %>
```

### With Icons

```erb
<%= render Shadcn::TabsComponent.new(default_value: "all") do |tabs| %>
  <% tabs.with_tab(value: "all", label: "All", icon: "layout-grid") do %>
    <p>All content</p>
  <% end %>

  <% tabs.with_tab(value: "assets", label: "Assets", icon: "trending-up") do %>
    <p>Assets content</p>
  <% end %>

  <% tabs.with_tab(value: "debts", label: "Debts", icon: "trending-down") do %>
    <p>Debts content</p>
  <% end %>
<% end %>
```

### With URL Parameter Sync

```erb
<%= render Shadcn::TabsComponent.new(
  default_value: "all",
  url_param: "tab"
) do |tabs| %>
  <% tabs.with_tab(value: "all", label: "All") do %>
    <p>Content</p>
  <% end %>
<% end %>
```

URL will update to `?tab=all` when tab is selected.

### Account Type Tabs (Real Example)

```erb
<%= render Shadcn::TabsComponent.new(
  default_value: params[:tab] || "all",
  url_param: "tab"
) do |tabs| %>
  <% tabs.with_tab(value: "all", label: "All", icon: "layout-grid") do %>
    <%= render "accounts/all_accounts" %>
  <% end %>

  <% tabs.with_tab(value: "asset", label: "Assets", icon: "trending-up") do %>
    <%= render "accounts/assets" %>
  <% end %>

  <% tabs.with_tab(value: "liability", label: "Debts", icon: "trending-down") do %>
    <%= render "accounts/liabilities" %>
  <% end %>
<% end %>
```

---

## 🎨 Component API

### `Shadcn::TabsComponent.new`

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `default_value` | String | **required** | Initial active tab value |
| `url_param` | String | `nil` | URL parameter name for sync (optional) |
| `class_name` | String | `nil` | Additional wrapper CSS classes |

### `tabs.with_tab`

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `value` | String | **required** | Unique tab identifier |
| `label` | String | **required** | Tab button text |
| `icon` | String | `nil` | Lucide icon name (optional) |
| `&block` | Block | **required** | Tab content |

---

## ⌨️ Keyboard Navigation

| Key | Action |
|-----|--------|
| `Arrow Left` | Previous tab |
| `Arrow Right` | Next tab |
| `Home` | First tab |
| `End` | Last tab |
| `Tab` | Move focus to tab panel |

---

## 🎯 Accessibility

The component includes:

- ✅ **ARIA Roles**: `tablist`, `tab`, `tabpanel`
- ✅ **ARIA States**: `aria-selected`, `aria-controls`, `aria-labelledby`
- ✅ **Focus Management**: Proper tabindex and focus states
- ✅ **Keyboard Navigation**: Full keyboard support
- ✅ **Screen Reader**: Descriptive labels and relationships

---

## 🎨 Styling

The component uses Permoney design system tokens:

```css
/* Active tab */
.bg-white              /* Active background */
.theme-dark:bg-gray-700  /* Dark mode active */
.text-primary          /* Active text */
.shadow-sm            /* Subtle shadow */

/* Inactive tab */
.text-secondary        /* Inactive text */
.hover:bg-surface-inset-hover  /* Hover state */

/* Container */
.bg-surface-inset      /* Tab list background */
```

### Custom Styling

Add custom classes via `class_name`:

```erb
<%= render Shadcn::TabsComponent.new(
  default_value: "all",
  class_name: "max-w-2xl mx-auto"
) do |tabs| %>
  <!-- tabs -->
<% end %>
```

---

## 🔧 How It Works

### 1. Stimulus Controller Registration

The controller is auto-registered as `shadcn--tabs`:

```javascript
// File: app/components/shadcn/tabs_controller.js
export default class extends Controller {
  static targets = ["trigger", "panel", "tablist"];
  static values = {
    default: String,
    urlParam: String,
  };
  // ...
}
```

### 2. Data Attributes (Rails 8.1 Conventions)

```html
<!-- Controller -->
<div data-controller="shadcn--tabs"
     data-shadcn--tabs-default-value="all"
     data-shadcn--tabs-url-param-value="tab">
  
  <!-- Trigger -->
  <button data-shadcn--tabs-target="trigger"
          data-tab-value="all"
          data-action="click->shadcn--tabs#selectTab">
    All
  </button>
  
  <!-- Panel -->
  <div data-shadcn--tabs-target="panel"
       data-tab-value="all">
    Content
  </div>
</div>
```

**Key Points:**
- ✅ Uses `--` (double dash) for namespacing
- ✅ Uses `-` (dash) for kebab-case in values
- ✅ Proper Rails 8.1 Stimulus conventions

### 3. Event Flow

1. User clicks tab button
2. `selectTab(event)` is called
3. `activateTab(value)` updates UI:
   - Updates `aria-selected` attributes
   - Toggles CSS classes
   - Shows/hides panels
4. Optional: Updates URL parameter

---

## 🆚 Comparison with Original DS::Tabs

| Feature | DS::Tabs | Shadcn::Tabs |
|---------|----------|--------------|
| **Design** | Custom | Shadcn/ui style |
| **Complexity** | High | Low |
| **Data Attributes** | Complex mapping | Simple, direct |
| **Icons** | No | Yes (Lucide) |
| **Keyboard Nav** | No | Yes |
| **Accessibility** | Basic | Full ARIA |
| **Rails 8.1** | Needs fixes | Native support |
| **Reliability** | ⚠️ Issues | ✅ Tested |

---

## 🐛 Troubleshooting

### Tabs Not Clickable

**Check:**
1. Is Stimulus loaded? Open console: `window.Stimulus`
2. Is controller registered? Check: `window.Stimulus.router.modulesByIdentifier.get("shadcn--tabs")`
3. Check browser console for errors
4. Restart `bin/dev` if using importmap

### Icons Not Showing

**Check:**
1. Icon name is correct (Lucide icon names)
2. `icon` helper is available
3. Example: `icon "layout-grid"` not `"layoutGrid"`

### Styling Issues

**Check:**
1. Tailwind classes are properly configured
2. Design system tokens are defined
3. Dark mode is working (`theme-dark:` classes)

---

## 📝 Migration Guide

### From DS::Tabs to Shadcn::Tabs

**Before:**
```erb
<%= render DS::Tabs.new(active_tab: "all") do |tabs| %>
  <% tabs.with_nav do |nav| %>
    <% nav.with_btn(id: "all", label: "All") %>
  <% end %>
  <% tabs.with_panel(tab_id: "all") do %>
    Content
  <% end %>
<% end %>
```

**After:**
```erb
<%= render Shadcn::TabsComponent.new(default_value: "all") do |tabs| %>
  <% tabs.with_tab(value: "all", label: "All", icon: "layout-grid") do %>
    Content
  <% end %>
<% end %>
```

**Changes:**
- `active_tab:` → `default_value:`
- `tabs.with_nav + tabs.with_panel` → `tabs.with_tab` (unified)
- `id:` → `value:`
- Added `icon:` support
- Simpler, cleaner API

---

## 🎓 Best Practices

### 1. Use Semantic Tab Values

```erb
<!-- ✅ Good -->
<% tabs.with_tab(value: "all", label: "All") %>
<% tabs.with_tab(value: "assets", label: "Assets") %>

<!-- ❌ Bad -->
<% tabs.with_tab(value: "tab1", label: "All") %>
<% tabs.with_tab(value: "tab2", label: "Assets") %>
```

### 2. Add Icons for Visual Context

```erb
<% tabs.with_tab(value: "assets", label: "Assets", icon: "trending-up") do %>
```

Icons help users understand tab content at a glance.

### 3. Use URL Sync for Shareable States

```erb
<%= render Shadcn::TabsComponent.new(
  default_value: params[:tab] || "all",
  url_param: "tab"
) do |tabs| %>
```

Allows users to bookmark and share specific tab views.

### 4. Keep Tab Content Lightweight

```erb
<!-- ✅ Good -->
<% tabs.with_tab(value: "all", label: "All") do %>
  <%= render "accounts/all" %>
<% end %>

<!-- ❌ Bad - Heavy logic in tab content -->
<% tabs.with_tab(value: "all", label: "All") do %>
  <% Account.all.each do |account| %>
    <!-- Complex rendering -->
  <% end %>
<% end %>
```

Use partials and move heavy logic to controllers/helpers.

---

## 🔬 Testing

### Unit Test Example

```ruby
# test/components/shadcn/tabs_component_test.rb
require "test_helper"

class Shadcn::TabsComponentTest < ViewComponent::TestCase
  test "renders tabs with default value" do
    render_inline(Shadcn::TabsComponent.new(default_value: "all")) do |tabs|
      tabs.with_tab(value: "all", label: "All") { "Content" }
    end

    assert_selector "[data-controller='shadcn--tabs']"
    assert_selector "[data-tab-value='all']"
    assert_text "All"
  end

  test "renders tabs with icons" do
    render_inline(Shadcn::TabsComponent.new(default_value: "all")) do |tabs|
      tabs.with_tab(value: "all", label: "All", icon: "layout-grid") { "Content" }
    end

    assert_selector "svg[data-lucide='layout-grid']"
  end
end
```

### System Test Example

```ruby
# test/system/tabs_test.rb
require "application_system_test_case"

class TabsTest < ApplicationSystemTestCase
  test "clicking tabs switches content" do
    visit tabs_demo_path

    assert_text "All Accounts"
    
    click_button "Assets"
    assert_text "Asset Accounts"
    
    click_button "Debts"
    assert_text "Liability Accounts"
  end

  test "keyboard navigation works" do
    visit tabs_demo_path

    find("button", text: "All").send_keys(:arrow_right)
    assert_selector "[aria-selected='true']", text: "Assets"
  end
end
```

---

## 📚 Related Documentation

- [Rails 8.1 Stimulus Conventions](./RAILS_8_1_UPGRADE.md)
- [Permoney Design System](../app/assets/tailwind/permoney-design-system.css)
- [ViewComponents Guide](https://viewcomponent.org/)
- [Stimulus Reference](https://stimulus.hotwired.dev/)
- [Lucide Icons](https://lucide.dev/icons/)

---

## 🎉 Live Demo

Visit **`/tabs-demo`** to see the component in action with:
- Account type tabs (All/Assets/Debts)
- Settings tabs (Profile/Security/Notifications)
- Feature showcase
- Interactive examples

---

## 💡 Tips

1. **Start Simple**: Begin with basic tabs, add features as needed
2. **Test Early**: Test clickability immediately after implementation
3. **Use Icons**: They improve UX and visual hierarchy
4. **Monitor Performance**: Tabs add minimal overhead, but check with many tabs
5. **Follow Conventions**: Stick to Rails 8.1 Stimulus patterns

---

## 🤝 Contributing

Found an issue or want to improve the component?

1. Check browser console for errors
2. Verify Stimulus controller is loaded
3. Test with `/tabs-demo` first
4. Report issues with reproduction steps

---

**Created:** October 28, 2025  
**Rails Version:** 8.1.0  
**Status:** ✅ Production Ready
