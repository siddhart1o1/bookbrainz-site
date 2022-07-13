import * as bootstrap from 'react-bootstrap';
import React from 'react';
import {Rating} from 'react-simple-star-rating';


const {Col, Row} = bootstrap;


function ReviewCard({reviewData}) {
	const publishedDate = new Date(reviewData.published_on).toDateString();
	let reviewText = reviewData.text;
	if (reviewText.length > 75) {
		reviewText = `${reviewText.substring(0, 75)}...`;
	}
	const reviewLink = `https://critiquebrainz.org/review/${reviewData.id}`;
	return (
		<div className="border bg-light p-2 mb-2" >
			<div>
				<Rating
					allowHalfIcon
					readonly
					allowHover={false}
					className="rating-stars"
					fillColor="#46433A"
					initialValue={reviewData.rating}
					ratingValue={0}
					size={15}
					stars={5}
				/>
				<small className="float-right">
                    Review by: <b>{reviewData.user.display_name}</b> {publishedDate}
				</small>
			</div>
			<div>
				{reviewText}
				<a className="float-right" href={reviewLink}>View &gt;</a>
			</div>
		</div>
	);
}

function EntityReviews({entity}) {
	const {reviews} = entity.reviews;
	let reviewContent;
	const mapEntityType = {
		EditionGroup: 'bb_edition_group'
	};
	const entityType = mapEntityType[entity.type];
	if (reviews.length) {
		reviewContent = (
			<React.Fragment>
				{
					reviews.slice(0, 3).map((review) => (
						<ReviewCard
							key={review.id}
							reviewData={review}
						/>
					))
				}
				<a href={`https://critiquebrainz.org/${entityType}/${entity.bbid}`}>View all reviews &gt;</a>
			</React.Fragment>
		);
	}
	return (
		<div>
			<h2>Reviews</h2>
			{reviewContent}
		</div>
	);
}

export default EntityReviews;
