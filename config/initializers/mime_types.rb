# app/config/initializers/mime_types.rb

# CSV MIME type
Mime::Type.register "text/csv", :csv

# PDF MIME type
Mime::Type.register "application/pdf", :pdf

# Excel MIME types
Mime::Type.register "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", :xlsx
