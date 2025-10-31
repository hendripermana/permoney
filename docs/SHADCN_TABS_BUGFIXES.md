# 🐛 SHADCN TABS - BUG FIXES

## Summary

Two bugs were discovered and fixed after initial implementation:

---

## Bug #1: ViewComponent Helper Access

### ❌ Error:
```
NoMethodError: undefined method 'icon' for an instance of Shadcn::TabsComponent
```

### 🔍 Root Cause:
ViewComponents in Rails **cannot call view helpers directly**. They must use the `helpers` proxy.

### 💡 Fix:
```erb
<!-- BEFORE (BROKEN) -->
<%= icon tab.icon, size: "sm" %>

<!-- AFTER (WORKS) -->
<%= helpers.icon tab.icon, size: "sm" %>
```

### 📚 Explanation:
In regular ERB views, you can call helpers directly:
```erb
<!-- In app/views/pages/index.html.erb -->
<%= icon "plus" %>  <!-- Works! -->
```

But in ViewComponents, you need the helpers proxy:
```erb
<!-- In app/components/my_component.html.erb -->
<%= helpers.icon "plus" %>  <!-- Must use helpers. prefix -->
```

This is a ViewComponent framework requirement to maintain proper scope separation.

### ✅ Commit:
```
82817f92 Fix ViewComponent helper access - use helpers.icon
```

---

## Bug #2: Icon Size Parameter Type

### ❌ Error:
```
NoMethodError: undefined method 'to_sym' for an instance of Integer
```

At `application_helper.rb:26`:
```ruby
sizes[size.to_sym]  # size is 16 (Integer), not :sm (Symbol)
```

### 🔍 Root Cause:
The `icon` helper expects size as a **string/symbol** (like `"sm"`, `:md`), not an **integer** (like `16`, `20`).

### 💡 Fix:
```erb
<!-- BEFORE (BROKEN) -->
<%= helpers.icon tab.icon, size: 16 %>

<!-- AFTER (WORKS) -->
<%= helpers.icon tab.icon, size: "sm" %>
```

### 📚 Explanation:
The icon helper uses a lookup hash:
```ruby
def icon(key, size: "md", color: "default", **opts)
  sizes = { 
    xs: "w-3 h-3",   # 12px
    sm: "w-4 h-4",   # 16px ← We want this
    md: "w-5 h-5",   # 20px
    lg: "w-6 h-6",   # 24px
    xl: "w-7 h-7",   # 28px
    "2xl": "w-8 h-8" # 32px
  }
  
  icon_classes = class_names(
    "shrink-0",
    sizes[size.to_sym],  # Requires size to be convertible to symbol
    colors[color.to_sym],
    extra_classes
  )
  # ...
end
```

When you pass `size: 16`:
- `16.to_sym` → Error! Integers don't have `to_sym` method

When you pass `size: "sm"`:
- `"sm".to_sym` → `:sm` → `sizes[:sm]` → `"w-4 h-4"` ✅

### ✅ Available Icon Sizes:
- `"xs"` → `w-3 h-3` (12px)
- `"sm"` → `w-4 h-4` (16px) ← **Used in tabs**
- `"md"` → `w-5 h-5` (20px) (default)
- `"lg"` → `w-6 h-6` (24px)
- `"xl"` → `w-7 h-7` (28px)
- `"2xl"` → `w-8 h-8` (32px)

### ✅ Commit:
```
946efba5 Fix icon size parameter - use symbol not integer
```

---

## Testing After Fixes

### ✅ What Should Work Now:

1. **Page Loads:**
   - Visit `/accounts`
   - No errors
   - Tabs render correctly

2. **Icons Display:**
   - All tab has `layout-grid` icon
   - Assets tab has `trending-up` icon
   - Debts tab has `trending-down` icon
   - Icons are small (16px / w-4 h-4)

3. **Tabs Function:**
   - Clicking switches content
   - Active tab has styling
   - URL updates

### 🧪 Quick Test:

```bash
# Start server
bin/dev

# Visit
http://localhost:3000/accounts

# Check console (F12)
# Should see NO errors
```

---

## Lessons Learned

### 1️⃣ **ViewComponent Helper Access**
Always use `helpers.` prefix when calling view helpers from ViewComponents:
```erb
<!-- DO -->
<%= helpers.icon "plus" %>
<%= helpers.link_to "Home", root_path %>
<%= helpers.current_page?(root_path) %>

<!-- DON'T -->
<%= icon "plus" %>  ❌
```

### 2️⃣ **Icon Helper API**
Always check the helper signature before using:
```ruby
# Check app/helpers/application_helper.rb
def icon(key, size: "md", color: "default", ...)
  # size expects: "xs", "sm", "md", "lg", "xl", "2xl"
  # NOT: 12, 16, 20, 24, 28, 32
end
```

### 3️⃣ **Test Rendering First**
When creating new components:
1. Create the component
2. **Test rendering** before committing
3. Fix any runtime errors
4. Then commit

---

## Prevention for Future

### ✅ Component Testing Checklist

When creating new ViewComponents:

- [ ] Test rendering in browser
- [ ] Check for helper access issues
- [ ] Verify all parameters types
- [ ] Check console for errors
- [ ] Test all component features
- [ ] Verify on multiple pages

### ✅ Code Review Checklist

Before committing components:

- [ ] All helpers use `helpers.` prefix?
- [ ] All parameters match helper signatures?
- [ ] Tested in actual application?
- [ ] No hardcoded values?
- [ ] Documentation complete?

---

## Files Modified

### Bug Fix Commits:
1. `82817f92` - Fix ViewComponent helper access
2. `946efba5` - Fix icon size parameter

### Files Changed:
- `app/components/shadcn/tabs_component.html.erb` (2 fixes)

---

## Current Status

✅ **BOTH BUGS FIXED**

The Shadcn tabs component should now work correctly:
- Icons display properly
- No ViewComponent errors
- Size parameter correct
- Ready for testing

---

**Created:** 2025-10-28  
**Bugs Fixed:** 2  
**Status:** Ready for testing
