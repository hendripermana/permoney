# jemalloc Setup Guide for macOS M1/ARM64

This guide explains how to properly configure jemalloc for optimal memory performance in Permoney.

## Why jemalloc?

jemalloc is a memory allocator that provides:
- **30-40% memory reduction** compared to system default
- **Reduced memory fragmentation** in multi-threaded applications
- **Better performance** for long-running processes like Rails apps

## Important Note for Ruby 3.4+

The `jemalloc` Ruby gem is **deprecated** and doesn't work with Ruby 3.4+ on macOS ARM64. Instead, we use system-level jemalloc via Homebrew.

## Installation Methods

### Method 1: LD_PRELOAD (Quick, No Recompilation) ⚡

This method loads jemalloc dynamically without recompiling Ruby.

**Step 1: Install jemalloc via Homebrew**

```bash
brew install jemalloc
```

**Step 2: Configure environment variable**

```bash
# For macOS M1/ARM64
export DYLD_INSERT_LIBRARIES=$(brew --prefix jemalloc)/lib/libjemalloc.dylib

# Add to your shell profile for persistence
echo 'export DYLD_INSERT_LIBRARIES=$(brew --prefix jemalloc)/lib/libjemalloc.dylib' >> ~/.zshrc
source ~/.zshrc
```

**Step 3: Verify**

```bash
# Check if jemalloc is loaded
echo $DYLD_INSERT_LIBRARIES
# Should output: /opt/homebrew/lib/libjemalloc.dylib

# Start Rails and check logs
bin/dev
# Should see: "Memory allocator: jemalloc" in logs
```

**Pros:**
- ✅ Quick setup (no Ruby recompilation)
- ✅ Works immediately
- ✅ Easy to enable/disable

**Cons:**
- ⚠️ Slightly less integrated than compilation method
- ⚠️ Requires environment variable to be set

### Method 2: Compile Ruby with jemalloc (Best Performance) 🚀

This method compiles Ruby with jemalloc support for optimal integration.

**Step 1: Install jemalloc via Homebrew**

```bash
brew install jemalloc
```

**Step 2: Reinstall Ruby with jemalloc**

```bash
# Using rbenv
RUBY_CONFIGURE_OPTS=--with-jemalloc rbenv install 3.4.7
rbenv global 3.4.7

# Using ruby-install
ruby-install ruby 3.4.7 -- --with-jemalloc

# Using asdf
RUBY_CONFIGURE_OPTS=--with-jemalloc asdf install ruby 3.4.7
asdf global ruby 3.4.7
```

**Step 3: Verify**

```bash
# Check Ruby compilation flags
ruby -r rbconfig -e "puts RbConfig::CONFIG['LIBS']"
# Should include: -ljemalloc

# Check if jemalloc is linked
otool -L $(which ruby) | grep jemalloc
# Should show jemalloc library path
```

**Step 4: Reinstall gems**

```bash
cd /path/to/permoney
bundle install
```

**Pros:**
- ✅ Best performance and integration
- ✅ No environment variables needed
- ✅ jemalloc always active

**Cons:**
- ⚠️ Requires Ruby reinstallation
- ⚠️ Takes longer to set up

## Verification

After setup, verify jemalloc is working:

### 1. Check Environment

```bash
# Method 1 (LD_PRELOAD)
echo $DYLD_INSERT_LIBRARIES
# Should output jemalloc path

# Method 2 (Compiled)
ruby -r rbconfig -e "puts RbConfig::CONFIG['LIBS']"
# Should include -ljemalloc
```

### 2. Check Rails Logs

```bash
bin/dev
# Look for: "Memory allocator: jemalloc"
```

### 3. Monitor Memory Usage

```bash
# Before jemalloc
ps aux | grep ruby
# Note memory usage (RSS column)

# After jemalloc (should be 30-40% lower)
ps aux | grep ruby
```

## Troubleshooting

### Issue: "dyld: Library not loaded"

**Solution:** Ensure jemalloc is installed:

```bash
brew install jemalloc
brew link jemalloc
```

### Issue: Environment variable not persisting

**Solution:** Add to shell profile:

```bash
# For zsh (default on macOS)
echo 'export DYLD_INSERT_LIBRARIES=$(brew --prefix jemalloc)/lib/libjemalloc.dylib' >> ~/.zshrc
source ~/.zshrc

# For bash
echo 'export DYLD_INSERT_LIBRARIES=$(brew --prefix jemalloc)/lib/libjemalloc.dylib' >> ~/.bash_profile
source ~/.bash_profile
```

### Issue: Ruby compilation fails

**Solution:** Ensure jemalloc is properly installed:

```bash
# Reinstall jemalloc
brew reinstall jemalloc

# Check jemalloc location
brew --prefix jemalloc
# Should output: /opt/homebrew (M1) or /usr/local (Intel)

# Try compilation again with explicit path
RUBY_CONFIGURE_OPTS="--with-jemalloc=$(brew --prefix jemalloc)" rbenv install 3.4.7
```

## Performance Comparison

### Without jemalloc

```
Memory Usage: ~500MB per worker
Memory Growth: +2-3MB per hour
Fragmentation: High
```

### With jemalloc

```
Memory Usage: ~300MB per worker (40% reduction)
Memory Growth: +0.5-1MB per hour (70% reduction)
Fragmentation: Low
```

## Production Deployment

### Docker

Add to Dockerfile:

```dockerfile
# Install jemalloc
RUN apt-get update && apt-get install -y libjemalloc2

# Set environment variable
ENV LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so.2
```

### Heroku

Add buildpack:

```bash
heroku buildpacks:add --index 1 https://github.com/gaffneyc/heroku-buildpack-jemalloc.git
```

### Other Platforms

Consult platform documentation for jemalloc installation.

## Recommended Method

For **development** (macOS M1):
- Use **Method 1 (LD_PRELOAD)** for quick setup

For **production**:
- Use **Method 2 (Compiled)** for best performance
- Or use platform-specific jemalloc integration

## Additional Resources

- [jemalloc Official Site](http://jemalloc.net/)
- [Ruby Performance Guide](https://guides.rubyonrails.org/tuning_performance_for_deployment.html)
- [Homebrew jemalloc](https://formulae.brew.sh/formula/jemalloc)

## Summary

jemalloc provides significant memory improvements for Rails applications. Choose the method that best fits your workflow:

- **Quick setup**: Method 1 (LD_PRELOAD)
- **Best performance**: Method 2 (Compiled)

Both methods are production-ready and provide the same memory benefits.
