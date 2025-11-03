class Settings::GuidesController < ApplicationController
  layout "settings"

  def show
    @breadcrumbs = [
      { text: "Home", href: root_path, icon: "home" },
      { text: "Guides", icon: "book-open" }
    ]
    markdown = Redcarpet::Markdown.new(Redcarpet::Render::HTML,
      autolink: true,
      tables: true,
      fenced_code_blocks: true,
      strikethrough: true,
      superscript: true
    )
    @guide_content = markdown.render(File.read(Rails.root.join("docs/onboarding/guide.md")))
  end
end
