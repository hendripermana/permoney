# frozen_string_literal: true

# Shadcn-style Tabs Component
# Modern, accessible tabs with icon support
#
# Usage:
#   <%= render Shadcn::TabsComponent.new(default_value: "all") do |tabs| %>
#     <% tabs.tab(value: "all", label: "All", icon: "layout-grid") do %>
#       <!-- All content -->
#     <% end %>
#     <% tabs.tab(value: "assets", label: "Assets", icon: "trending-up") do %>
#       <!-- Assets content -->
#     <% end %>
#   <% end %>
class Shadcn::TabsComponent < ViewComponent::Base
  renders_many :tabs, lambda { |value:, label:, icon: nil, &block|
    Tab.new(value: value, label: label, icon: icon, active: value == @default_value, &block)
  }

  attr_reader :default_value, :identifier

  def initialize(default_value:, url_param: nil, class_name: nil)
    @default_value = default_value
    @url_param = url_param
    @class_name = class_name
    @identifier = "tabs-#{SecureRandom.hex(4)}"
  end

  def wrapper_classes
    class_names(
      "w-full",
      @class_name
    )
  end

  # Individual Tab class
  class Tab < ViewComponent::Base
    attr_reader :value, :label, :icon, :active

    def initialize(value:, label:, icon: nil, active: false, &block)
      @value = value
      @label = label
      @icon = icon
      @active = active
      @content_block = block
    end

    def call
      @content_block.call if @content_block
    end
  end
end
