# frozen_string_literal: true

class BoxCarouselComponent < ApplicationComponent
  attr_reader :items, :width, :height, :direction, :auto_play, :auto_play_interval, :enable_drag, :perspective

  def initialize(
    items:,
    width: 350,
    height: 250,
    direction: "right",
    auto_play: false,
    auto_play_interval: 3000,
    enable_drag: true,
    perspective: 1000,
    **options
  )
    @items = items
    @width = width
    @height = height
    @direction = direction
    @auto_play = auto_play
    @auto_play_interval = auto_play_interval
    @enable_drag = enable_drag
    @perspective = perspective
    super(**options)
  end

  def carousel_data
    {
      controller: "box-carousel",
      box_carousel_items_value: items.to_json,
      box_carousel_width_value: width,
      box_carousel_height_value: height,
      box_carousel_direction_value: direction,
      box_carousel_auto_play_value: auto_play,
      box_carousel_auto_play_interval_value: auto_play_interval,
      box_carousel_enable_drag_value: enable_drag,
      box_carousel_perspective_value: perspective
    }
  end
end
