lib_path = File.expand_path("../lib", __dir__)
$LOAD_PATH.unshift(lib_path) unless $LOAD_PATH.include?(lib_path)

ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

require "bundler/setup" # Set up gems listed in the Gemfile.
require "bootsnap/setup" # Speed up boot time by caching expensive operations.

# Backward compatibility for connection_pool 3.x (keyword-only initializer)
# Rails 8.1 Redis cache store may call ConnectionPool.new with a single hash.
# Patch early, before environments configure cache_store.
begin
  require "connection_pool"

  unless ConnectionPool.instance_variable_defined?(:@__permoney_patched)
    ConnectionPool.instance_variable_set(:@__permoney_patched, true)

    ConnectionPool.class_eval do
      __permoney_orig_initialize = instance_method(:initialize)

      define_method(:initialize) do |*args, **kwargs, &block|
        if args.first.is_a?(Hash) && kwargs.empty?
          kwargs = args.shift.transform_keys { |k| k.respond_to?(:to_sym) ? k.to_sym : k }
        elsif kwargs.empty? && args.length == 1
          kwargs = { size: args.shift }
        elsif kwargs.empty? && args.length == 2
          timeout, size = args
          kwargs = { timeout:, size: }
          args = []
        end

        __permoney_orig_initialize.bind_call(self, *args, **kwargs, &block)
      end
    end
  end
rescue LoadError
  # connection_pool not available yet; cache_store config will fail similarly,
  # but we avoid breaking boot in environments that don't use Redis.
end
