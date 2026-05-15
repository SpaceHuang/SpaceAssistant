type Props = {
  dataUrl: string
  alt: string
}

export function ImageView({ dataUrl, alt }: Props) {
  return (
    <div className="detail-image-view">
      <img src={dataUrl} alt={alt} />
    </div>
  )
}
