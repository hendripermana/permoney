# An extension to `link_to` helper.  All options are passed through to the `link_to` helper with some additional
# options available.
class DS::Link < DS::Buttonish
  attr_reader :frame

  VARIANTS = VARIANTS.reverse_merge(
    default: {
      container_classes: "",
      icon_classes: "fg-gray"
    }
  ).freeze

  def merged_opts
    merged_opts = opts.dup || {}
    method = merged_opts.delete(:method)
    data = merged_opts.delete(:data) || {}

    if frame
      data = data.merge(turbo_frame: frame)
    end

    if method.present? && method.to_s != "get"
      data = data.merge(turbo_method: method)
      merged_opts[:rel] = class_names(merged_opts[:rel], "nofollow")
    end

    merged_opts.merge(
      class: class_names(container_classes, extra_classes),
      data: data
    )
  end

  private
    def container_size_classes
      super unless variant == :default
    end
end
