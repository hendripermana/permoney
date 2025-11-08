class Settings::GuidesController < ApplicationController
  layout "settings"

  def show
    @breadcrumbs = [
      { text: "Home", href: root_path, icon: "home" },
      { text: "Guides", icon: "book-open" }
    ]
    
    guide_path = Rails.root.join("docs/onboarding/guide.md")
    
    if !File.exist?(guide_path)
      @guide_content = "<p class='text-red-500'>Guide not found. Please ensure docs/onboarding/guide.md exists.</p>"
      return
    end
    
    markdown = Redcarpet::Markdown.new(Redcarpet::Render::HTML,
      autolink: true,
      tables: true,
      fenced_code_blocks: true,
      strikethrough: true,
      superscript: true
    )
    
    @guide_content = markdown.render(File.read(guide_path))
  rescue => e
    Rails.logger.error("Error loading guide: #{e.message}")
    @guide_content = "<p class='text-red-500'>Error loading guide: #{e.message}</p>"
  end
end
