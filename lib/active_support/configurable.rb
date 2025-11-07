# frozen_string_literal: true

# Rails 8.1 deprecates ActiveSupport::Configurable without replacement and
# removes it in 8.2. Several dependencies (ViewComponent, OmniAuth helpers, etc.)
# still rely on the constant though, so we provide a drop-in implementation that
# mirrors the public API using `class_attribute` + `ActiveSupport::InheritableOptions`.
# This file must load before any gem tries to `require "active_support/configurable"`
# to avoid triggering the upstream warning.
return if defined?(ActiveSupport::Configurable)

require "active_support/concern"
require "active_support/ordered_options"

module ActiveSupport
  module Configurable
    extend ActiveSupport::Concern

    included do
      class_attribute :_configurable_options, instance_writer: false, default: nil
    end

    class_methods do
      def config
        self._configurable_options ||= begin
          if respond_to?(:superclass) && superclass.respond_to?(:config)
            superclass.config.inheritable_copy
          else
            ActiveSupport::InheritableOptions.new
          end
        end
      end

      def configure
        yield config
      end

      def config_accessor(*names, instance_reader: true, instance_writer: true, instance_accessor: true, default: nil, &block)
        names.each do |name|
          raise NameError, "invalid config attribute name" unless /\A[_A-Za-z]\w*\z/.match?(name)

          reader, reader_line = "def #{name}; config.#{name}; end", __LINE__
          writer, writer_line = "def #{name}=(value); config.#{name} = value; end", __LINE__

          singleton_class.class_eval(reader, __FILE__, reader_line)
          singleton_class.class_eval(writer, __FILE__, writer_line)

          if instance_accessor
            class_eval(reader, __FILE__, reader_line) if instance_reader
            class_eval(writer, __FILE__, writer_line) if instance_writer
          end

          send("#{name}=", block_given? ? yield : default)
        end
      end
    end
  end
end
