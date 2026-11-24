"""relay_listings.py's pure parts: which attachments are photos, the cleaned photo, upload batches and the reply links."""
import io

from PIL import Image

import relay_listings as rl


def jpeg_with_exif() -> bytes:
    im = Image.new("RGB", (4000, 3000), (200, 30, 30))
    exif = Image.Exif()
    exif[0x010F] = "Phone maker"  # Make
    exif[0x0112] = 6              # Orientation: rotated
    out = io.BytesIO()
    im.save(out, "JPEG", exif=exif)
    return out.getvalue()


def test_photos_are_images_big_enough_not_to_be_a_signature():
    assert rl.is_photo({"filename": "IMG_0629.jpeg", "sizeBytes": 510849})
    assert rl.is_photo({"filename": "pack.PNG", "sizeBytes": 90_000})
    assert not rl.is_photo({"filename": "logo.png", "sizeBytes": 4_000})
    assert not rl.is_photo({"filename": "datasheet.pdf", "sizeBytes": 900_000})
    assert not rl.is_photo({"filename": "IMG_1.heic", "sizeBytes": 900_000})


def test_a_cleaned_photo_is_upright_smaller_and_carries_no_metadata():
    cleaned = rl.clean_photo(jpeg_with_exif())
    with Image.open(io.BytesIO(cleaned)) as im:
        assert im.format == "JPEG"
        assert max(im.size) == rl.PHOTO_SIDE
        assert im.size == (1200, 1600)  # turned upright from the EXIF orientation
        assert not im.getexif()
        assert "exif" not in im.info and "icc_profile" not in im.info


def test_batches():
    assert rl.batches([1, 2, 3, 4, 5, 6, 7], 3) == [[1, 2, 3], [4, 5, 6], [7]]
    assert rl.batches([], 3) == []


def test_the_first_group_gets_the_setup_link_and_the_others_their_invitation_path():
    groups = [{"group": {"label": "35E packs"}}, {"group": {"label": "50E packs"}}]
    issued = {0: {"url": "https://www.rebattery.io/join/tok", "invitationId": "a"}, 1: {"url": "https://www.rebattery.io/join/old", "invitationId": "b"}}
    assert rl.links_for(groups, issued, "https://www.rebattery.io") == [
        {"label": "35E packs", "url": "https://www.rebattery.io/join/tok"},
        {"label": "50E packs", "url": "https://www.rebattery.io/supplier/listings/new?invitation=b"},
    ]
